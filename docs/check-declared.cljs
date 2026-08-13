#!/usr/bin/env nbb
;; docs/check-declared.cljs — can what this repo declares actually be obtained?
;;
;;   nbb docs/check-declared.cljs           # from the repo root
;;
;; The code in this repo works: two vitest suites pass (see
;; docs/operator-quickstart.md). What does not work is *getting to* it. The
;; declared install path is dead in two independent places, the declared
;; runtime host is gone, and the declared DID does not resolve. None of that
;; is visible from reading the source, which looks fine, so it has to be
;; measured. Five things are measured, and they fail independently:
;;
;;   1. extraction   — migration.edn states a file count and a byte total for
;;                     what was lifted out of etzhayyim/root. Does the first
;;                     commit still match it, and has anything drifted since?
;;   2. dependencies — every git and `workspace:` dependency reachable from
;;                     the package.json files here. A git spec pinned to a SHA
;;                     is reproducible; one pointing at a branch is not, and a
;;                     package.json with no `name` cannot be installed at all.
;;                     This is walked transitively, because the break is two
;;                     hops out and one hop would report all-clear.
;;   3. hosts        — the actor DID and the downstream it hands mail to are
;;                     `*.etzhayyim.com` names. Do they exist?
;;   4. licence docs — NOTICE binds the user to a rider document by filename.
;;                     Is that file here to be read?
;;   5. migration    — MIGRATION-TODO.md says this app still sits on substrates
;;                     the charter forbids. Is that still true?
;;
;; The README states all five as a dated measurement. A dated measurement
;; rots. This re-takes it.
;;
;; Nothing about the dependency graph is hardcoded: the specs are read out of
;; the package.json files, and each hop is followed by fetching that package's
;; own package.json. Add a dependency and it comes under the check by itself.
;;
;; Exit codes are three-valued on purpose. "Could not measure" must not be
;; reachable from the same exit code as "measured, all fine":
;;
;;   0  everything declared can be obtained
;;   1  at least one declared thing cannot be           <- the state on 2026-08-14
;;   3  COULD NOT ANSWER — nothing was extracted (wrong directory?), the
;;      control host failed so DNS here proves nothing, the network could not
;;      be reached so an unresolvable dependency proves nothing, or git could
;;      not describe the tree. Never report a pass from this state.

(ns check-declared
  (:require ["node:child_process" :as cp]
            ["node:dns/promises" :as dns]
            ["node:fs" :as fs]
            ["node:path" :as path]
            ["node:process" :as process]
            [clojure.string :as str]
            [promesa.core :as p]))

;; A host we do not control, used only to prove DNS works at all. If this
;; fails, every NXDOMAIN below is uninterpretable.
(def control-host "registry.npmjs.org")

;; Likewise for HTTPS: if this 404s or throws, a dependency we could not fetch
;; says nothing about the dependency.
(def control-url "https://registry.npmjs.org/vitest")

(def skip-dirs #{"node_modules" ".git" "dist" "build" ".vite-temp"})

;; Substrates MIGRATION-TODO.md names as violations to remove. Transcribed
;; from that file's remediation list — the list lives in prose there, and
;; guessing it out of prose would be less honest than copying it here where a
;; reader can compare the two. Each is a pattern that would betray the
;; substrate in source, not a mention of it in documentation.
(def forbidden-substrates
  [["@atproto/api direct"  #"from\s+[\"']@atproto/api[\"']|require\([\"']@atproto/api[\"']\)"]
   ["viem"                 #"from\s+[\"']viem[\"']|require\([\"']viem[\"']\)"]
   ["Kysely"               #"(?i)kysely"]
   ["Drizzle"              #"drizzle-orm"]
   ["Prisma"               #"@prisma/client"]
   ["RisingWave"           #"(?i)risingwave"]
   ["Postgres direct"      #"\bfrom\s+[\"']pg[\"']|\bnew\s+Pool\("]
   ["Stripe"               #"(?i)\bstripe\b"]
   ["PayPal"               #"(?i)\bpaypal\b"]
   ["GA4 / Meta Pixel"     #"gtag\(|\bfbq\(|googletagmanager"]])

(def source-exts #{".ts" ".tsx" ".js" ".mjs" ".cjs" ".svelte" ".html"})

;; ── file helpers ────────────────────────────────────────────────────

(defn walk
  "Every file under dir with one of exts, skipping build output and vendored
   trees. `nil` exts means every file."
  [dir exts]
  (reduce
   (fn [acc entry]
     (let [nm (.-name entry)
           full (path/join dir nm)]
       (cond
         (.isDirectory entry) (if (contains? skip-dirs nm) acc (into acc (walk full exts)))
         (or (nil? exts) (contains? exts (path/extname nm))) (conj acc full)
         :else acc)))
   []
   (try (fs/readdirSync dir #js {:withFileTypes true}) (catch :default _ #js []))))

(defn- read-text [f]
  (try (str (fs/readFileSync f "utf8")) (catch :default _ nil)))

(defn- read-json [f]
  (try (js->clj (js/JSON.parse (read-text f)) :keywordize-keys false)
       (catch :default _ nil)))

(defn- git
  "git output as a string, or nil when git could not answer. stderr is dropped:
   outside a repo git writes 'fatal: not a git repository', which would print
   above our own COULD-NOT-ANSWER line and read like the script crashed."
  [root & args]
  (try
    (str (cp/execFileSync "git" (clj->js (into ["-c" "core.fsmonitor=false"] args))
                          #js {:cwd root :encoding "utf8"
                               :stdio #js ["ignore" "pipe" "ignore"]}))
    (catch :default _ nil)))

;; ── 1. extraction ───────────────────────────────────────────────────

(defn extraction-claim
  "{:files n :bytes n :additions #{...}} from migration.edn, or nil. Read with
   regexes rather than an EDN parser so this script has no reader dependency
   and cannot fail closed on an unrelated syntax change."
  [root]
  (when-let [t (read-text (path/join root "migration.edn"))]
    (let [n (some-> (re-find #":tracked-files\s+(\d+)" t) second js/parseInt)
          b (some-> (re-find #":bytes\s+(\d+)" t) second js/parseInt)
          adds (some-> (re-find #":allowed-additions\s*\[([^\]]*)\]" t) second)]
      (when (and n b)
        {:files n :bytes b
         :additions (into (sorted-set) (map second (re-seq #"\"([^\"]+)\"" (or adds ""))))}))))

(defn root-tree
  "[{:path :bytes}] of the repo's first commit — the extraction itself — or nil.
   Found by ancestry, not by a hardcoded SHA, so later commits cannot move it."
  [root]
  (when-let [sha (some-> (git root "rev-list" "--max-parents=0" "HEAD") str/trim not-empty)]
    (when-let [out (git root "ls-tree" "-r" "--long" sha)]
      {:sha (subs sha 0 7)
       :entries (keep (fn [line]
                        (let [[_ b p] (re-find #"^\S+\s+blob\s+\S+\s+(\d+)\t(.+)$" line)]
                          (when p {:path p :bytes (js/parseInt b)})))
                      (str/split-lines out))})))

(defn extraction-drift
  "Extracted paths that differ *now*, as 'STATUS<TAB>path' lines, or nil when
   git could not answer.

   Two details are load-bearing. The comparison is commit-to-WORKING-TREE, not
   commit-to-HEAD: an uncommitted edit is still drift, and an earlier version
   of this compared against HEAD and so reported `UNCHANGED` while a modified
   file sat in the tree. And --diff-filter=MD keeps it to paths the extraction
   actually contained — added files are this repo's later work, not drift in
   what was lifted out of etzhayyim/root."
  [root sha]
  (when-let [out (git root "diff" "--name-status" "--diff-filter=MD" sha)]
    (remove str/blank? (str/split-lines out))))

;; ── 2. dependencies ─────────────────────────────────────────────────

(defn package-manifests
  "Every package.json in the tree, as [rel parsed]."
  [root]
  (keep (fn [f]
          (when (= "package.json" (path/basename f))
            (when-let [j (read-json f)] [(path/relative root f) j])))
        (walk root nil)))

(defn deps-of [j]
  (apply merge (map #(get j %) ["dependencies" "devDependencies" "optionalDependencies"])))

(defn parse-git-spec
  "{:owner :repo :ref} for a GitHub git dependency spec, or nil for anything
   else (registry ranges, workspace:, file:). Both git+https and git+ssh forms
   appear in this graph."
  [spec]
  (when (string? spec)
    (when-let [[_ owner repo ref]
               (re-find #"github(?:\.com[:/]|:)([^/]+)/([^/#.]+)(?:\.git)?(?:#(.+))?$" spec)]
      {:owner owner :repo repo :ref (or ref "HEAD")})))

(def sha-ref? #(re-matches #"[0-9a-f]{40}" (or % "")))

(defn fetch-package-json
  "Promise of {:ok? bool :name s :deps {}} for owner/repo at ref, or
   {:unreachable reason} — which is 'could not measure', never 'missing'.
   raw.githubusercontent.com serves renamed repositories at their old path, so
   a moved dependency is still followable."
  [{:keys [owner repo ref]}]
  (let [url (str "https://raw.githubusercontent.com/" owner "/" repo "/" ref "/package.json")]
    (-> (js/fetch url)
        (p/then (fn [r]
                  (if (.-ok r)
                    (p/then (.text r)
                            (fn [t]
                              (try
                                (let [j (js->clj (js/JSON.parse t) :keywordize-keys false)]
                                  {:ok? true :name (get j "name") :deps (deps-of j)})
                                (catch :default _ {:unreachable "package.json is not JSON"}))))
                    (if (= 404 (.-status r))
                      ;; A 404 on a pinned ref is a real answer: nothing to install.
                      {:ok? true :name nil :deps {} :absent true}
                      {:unreachable (str "HTTP " (.-status r))}))))
        (p/catch (fn [e] {:unreachable (or (.-message e) "fetch failed")})))))

(defn walk-git-deps
  "Breadth-first over the git dependency graph. Returns a promise of
   {:nodes [{:coord :from :dep :floating? :name :absent}] :unreachable [...]}.
   Capped: a runaway graph must not turn this into a package manager."
  [seeds]
  (let [cap 60]
    (p/loop [queue (vec seeds) seen #{} nodes [] unreachable []]
      (let [[head & tail] queue
            coord (when head (select-keys (:coord head) [:owner :repo :ref]))
            key (when head (str (:owner coord) "/" (:repo coord) "#" (:ref coord)))]
        (cond
          (nil? head) {:nodes nodes :unreachable unreachable}
          (>= (count nodes) cap) {:nodes nodes :unreachable unreachable :capped true}
          (contains? seen key) (p/recur (vec tail) seen nodes unreachable)
          :else
          (p/let [r (fetch-package-json coord)]
            (if (:unreachable r)
              (p/recur (vec tail) (conj seen key) nodes
                       (conj unreachable (str key " — " (:unreachable r))))
              (let [node (assoc head :name (:name r) :absent (:absent r)
                                :floating? (not (sha-ref? (:ref coord))))
                    next (keep (fn [[d spec]]
                                 (when-let [c (parse-git-spec spec)]
                                   {:coord c :from (str (or (:name r) key)) :dep d}))
                               (:deps r))]
                (p/recur (into (vec tail) next) (conj seen key) (conj nodes node) unreachable)))))))))

(defn workspace-deps
  "package name -> sorted set of package.json files depending on it via the
   `workspace:` protocol. These are the ones an extraction can break: a
   registry dependency is npm's problem, not this repo's."
  [manifests]
  (reduce (fn [acc [rel j]]
            (reduce (fn [a [dep spec]]
                      (if (and (string? spec) (str/starts-with? spec "workspace:"))
                        (update a dep (fnil conj (sorted-set)) rel)
                        a))
                    acc (deps-of j)))
          {} manifests))

(defn on-registry?
  "Promise of true / false / :error for an npm package name."
  [nm]
  (-> (js/fetch (str "https://registry.npmjs.org/" (str/replace nm "/" "%2f"))
                #js {:method "HEAD"})
      (p/then (fn [r] (cond (.-ok r) true (= 404 (.-status r)) false :else :error)))
      (p/catch (fn [_] :error))))

;; ── 3. hosts ────────────────────────────────────────────────────────

(defn collect-hosts
  "host -> sorted set of repo-relative files declaring it. Prose is excluded
   (no .md): otherwise this README's own status table would register as a
   declaration of the very hosts it reports as missing."
  [root]
  (reduce (fn [acc f]
            (let [rel (path/relative root f)]
              (reduce (fn [a h] (update a h (fnil conj (sorted-set)) rel))
                      acc
                      (set (map str/lower-case
                                (re-seq #"(?i)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+etzhayyim\.com"
                                        (or (read-text f) "")))))))
          {}
          (walk root (conj source-exts ".json" ".jsonld" ".edn"))))

(defn resolves?
  "true / false, or :error when the lookup failed for a reason that is not
   NXDOMAIN — so a transient resolver fault is never read as a missing host."
  [h]
  (-> (dns/lookup h)
      (p/then (fn [_] true))
      (p/catch (fn [e] (if (contains? #{"ENOTFOUND" "ENODATA"} (.-code e)) false :error)))))

;; ── 4. licence docs ─────────────────────────────────────────────────

(defn referenced-docs
  "doc filename -> the NOTICE-like files pointing at it. NOTICE conditions the
   licence grant on a rider named by filename; a licence citing a document
   nobody shipped cannot be complied with, so it is checked like any other
   declaration. Only NOTICE files are scanned — pulling filenames out of .md
   prose would make the README's own links register as licence references."
  [root]
  (reduce (fn [acc nm]
            (if-let [t (read-text (path/join root nm))]
              (reduce (fn [a d] (update a d (fnil conj (sorted-set)) nm))
                      acc (map second (re-seq #"\b([A-Z][A-Za-z0-9_-]*\.md)\b" t)))
              acc))
          {}
          (filter #(str/starts-with? % "NOTICE")
                  (try (vec (fs/readdirSync root)) (catch :default _ [])))))

;; ── 5. migration ────────────────────────────────────────────────────

(defn substrate-hits
  "[[label #{files}]] for every forbidden substrate still present in source."
  [root]
  (let [files (walk root source-exts)
        texts (map (fn [f] [(path/relative root f) (or (read-text f) "")]) files)]
    (keep (fn [[label pat]]
            (let [hit (into (sorted-set) (keep (fn [[rel t]] (when (re-find pat t) rel)) texts))]
              (when (seq hit) [label hit])))
          forbidden-substrates)))

;; ── report ──────────────────────────────────────────────────────────

(defn -main []
  (let [root (process/cwd)
        manifests (package-manifests root)
        provided (set (keep (fn [[_ j]] (get j "name")) manifests))
        ws (workspace-deps manifests)
        seeds (mapcat (fn [[rel j]]
                        (keep (fn [[d spec]]
                                (when-let [c (parse-git-spec spec)] {:coord c :from rel :dep d}))
                              (deps-of j)))
                      manifests)
        hosts-decl (collect-hosts root)
        hosts (sort (keys hosts-decl))
        claim (extraction-claim root)
        tree (root-tree root)
        refs (referenced-docs root)
        missing-docs (remove #(fs/existsSync (path/join root %)) (sort (keys refs)))
        hits (substrate-hits root)]
    (p/let [control (resolves? control-host)
            net (-> (js/fetch control-url #js {:method "HEAD"})
                    (p/then (fn [r] (.-ok r))) (p/catch (fn [_] false)))]
      (cond
        (not (true? control))
        (do (println (str "COULD NOT ANSWER: control host " control-host " did not resolve."))
            (println "DNS is not working here, so an NXDOMAIN below would prove nothing.")
            (process/exit 3))

        (not net)
        (do (println (str "COULD NOT ANSWER: " control-url " was not reachable."))
            (println "A dependency that cannot be fetched would prove nothing about the dependency.")
            (process/exit 3))

        (nil? tree)
        (do (println "COULD NOT ANSWER: git could not describe this tree.")
            (println "Run from inside the repository, with git on PATH.")
            (process/exit 3))

        ;; Evidence floor: an empty scan must not look like a clean scan.
        (and (empty? seeds) (empty? ws) (empty? hosts))
        (do (println (str "COULD NOT ANSWER: scanned " (count manifests) " package.json and 0 "
                          "declarations under " root "."))
            (println "Expected at least one git dependency, workspace dependency or host. Wrong directory?")
            (process/exit 3))

        :else
        (p/let [graph (walk-git-deps seeds)
                dns-rows (p/all (map (fn [h] (p/let [r (resolves? h)] [h r])) hosts))
                ws-rows (p/all (map (fn [[d _]] (p/let [r (on-registry? d)] [d r])) ws))]
          (let [{:keys [nodes unreachable capped]} graph
                floating (filter :floating? nodes)
                unnamed (filter #(and (nil? (:name %)) (not (:absent %))) nodes)
                absent (filter :absent nodes)
                dns-bad (map first (filter (fn [[_ r]] (false? r)) dns-rows))
                dns-err (map first (filter (fn [[_ r]] (= :error r)) dns-rows))
                ws-missing (remove (fn [[d _]] (contains? provided d)) ws-rows)
                ws-err (filter (fn [[_ r]] (= :error r)) ws-missing)
                tree-files (count (:entries tree))
                tree-bytes (reduce + 0 (map :bytes (:entries tree)))
                add-bytes (reduce + 0 (keep (fn [{:keys [path bytes]}]
                                              (when (contains? (:additions claim) path) bytes))
                                            (:entries tree)))
                drift (extraction-drift root (:sha tree))]

            (println (str "SCANNED\t" (count manifests) " package.json, " (count nodes)
                          " git dependency nodes, " (count hosts) " hosts, "
                          (count (walk root source-exts)) " source files"))
            (println)

            ;; 1 ── extraction
            (println "## extraction")
            (if (nil? claim)
              (println "  UNKNOWN\tmigration.edn states no file count / byte total")
              (let [ok (and (= tree-files (+ (:files claim) (count (:additions claim))))
                            (= tree-bytes (+ (:bytes claim) add-bytes)))]
                (println (str "  " (if ok "INTACT " "DRIFTED") "\tfirst commit " (:sha tree) ": "
                              tree-files " files / " tree-bytes " bytes = declared "
                              (:files claim) " / " (:bytes claim) " + "
                              (count (:additions claim)) " allowed additions / " add-bytes " bytes"))))
            (if (seq drift)
              (do (println (str "  CHANGED\t" (count drift) " extracted path(s) differ from the extraction:"))
                  (doseq [d drift] (println (str "    " d))))
              (println "  UNCHANGED\tevery extracted path is byte-identical"))
            (println)

            ;; 2 ── dependencies
            (println "## dependencies")
            (println (str "  walked " (count nodes) " git package(s)"
                          (when capped " (CAP REACHED — graph truncated)")))
            (doseq [{:keys [coord from dep name absent floating?]} nodes]
              (println (str "  " (cond absent "GONE   " (nil? name) "UNNAMED" floating? "FLOATING" :else "PINNED ")
                            "\t" dep " <- " from
                            "\n            " (:owner coord) "/" (:repo coord) "#"
                            (if (sha-ref? (:ref coord)) (subs (:ref coord) 0 7) (:ref coord))
                            (str/join (cond-> []
                                        absent (conj "  (no package.json at that ref)")
                                        (and (nil? name) (not absent))
                                        (conj "  (package.json has no \"name\" — not installable)")
                                        floating? (conj "  (branch ref — not reproducible)"))))))
            (doseq [[d on-npm] ws-rows]
              (println (str "  " (cond (contains? provided d) "PROVIDED"
                                       (true? on-npm) "ON-NPM  "
                                       (false? on-npm) "MISSING "
                                       :else "UNKNOWN ")
                            "\t" d " (workspace:*) <- " (str/join ", " (get ws d))
                            (when (false? on-npm) "  (not in this repo, 404 on the registry)"))))
            (when (seq unreachable)
              (println (str "  UNKNOWN\t" (count unreachable) " package(s) could not be fetched:"))
              (doseq [u unreachable] (println (str "    " u))))
            (println)

            ;; 3 ── hosts
            (println "## hosts")
            (doseq [[h r] dns-rows]
              (println (str "  " (case r true "RESOLVES" false "NXDOMAIN" "ERROR   ")
                            "\t" h " <- " (str/join ", " (get hosts-decl h)))))
            (println)

            ;; 4 ── licence
            (println "## licence documents")
            (if (empty? refs)
              (println "  none referenced by NOTICE")
              (doseq [[d by] refs]
                (println (str "  " (if (fs/existsSync (path/join root d)) "PRESENT" "ABSENT ")
                              "\t" d " <- " (str/join ", " by)))))
            (println)

            ;; 5 ── migration
            (println "## migration (MIGRATION-TODO.md)")
            (if (empty? hits)
              (println "  CLEAR\tnone of the forbidden substrates appear in source")
              (doseq [[label files] hits]
                (println (str "  PRESENT\t" label " in " (str/join ", " files)))))
            (println)

            ;; verdict
            (let [could-not (concat unreachable (map first ws-err) dns-err
                                    (when capped ["dependency graph truncated at the cap"]))]
              (cond
                (seq could-not)
                (do (println (str "COULD NOT ANSWER: " (count could-not)
                                  " item(s) were not measurable; the rest are reported above."))
                    (process/exit 3))

                (or (seq floating) (seq unnamed) (seq absent) (seq dns-bad)
                    (seq (remove (fn [[d _]] (contains? provided d)) ws-rows))
                    (seq missing-docs) (seq hits) (seq drift))
                (do (println (str (count floating) " dependency ref(s) float on a branch; "
                                  (count unnamed) " package(s) cannot be named; "
                                  (count (remove (fn [[d _]] (contains? provided d)) ws-rows))
                                  " workspace dependency is unsatisfiable; "
                                  (count dns-bad) " of " (count hosts) " declared hosts do not exist; "
                                  (count missing-docs) " licence document(s) were not shipped; "
                                  (count hits) " forbidden substrate(s) remain."))
                    (process/exit 1))

                :else
                (do (println "Everything this repo declares can be obtained. The README is stale.")
                    (process/exit 0))))))))))

(-main)
