package com.yuyuframe.launcheragent.runtime.mapping;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Mappings Yarn au format tiny v2 (official ↔ intermediary ↔ named).
 *
 * Copie indépendante de celle du p2p-agent — LauncherAgent doit fonctionner
 * même si le p2p-agent n'est pas chargé dans la JVM, et inversement.
 *
 * Indexation "intermediary" (official→intermediary, directe) ajoutée pour la
 * compatibilité Fabric : sous Fabric, les classes/méthodes/champs du jeu sont
 * nommés "intermediary" à l'exécution (ex: method_25426), pas avec les noms
 * obfusqués bruts de Mojang ("official", ex: bg_) que tout notre code de
 * réflexion utilise en dur — voir MappingsRegistry.Scheme et
 * docs/LauncherAgent/index.md.
 */
public final class YarnMappings {

    public static final class MethodEntry {
        public final String officialName;
        public final String officialDesc;
        MethodEntry(String name, String desc) {
            this.officialName = name;
            this.officialDesc = desc;
        }
        @Override public String toString() { return officialName + officialDesc; }
    }

    public static final class FieldEntry {
        public final String officialName;
        FieldEntry(String name) { this.officialName = name; }
        @Override public String toString() { return officialName; }
    }

    private static volatile boolean loaded = false;

    private static Map<String, MethodEntry> methodsByNamed = Collections.emptyMap();
    private static Map<String, MethodEntry> methodsByNamedAndDesc = Collections.emptyMap();
    private static Map<String, FieldEntry>  fieldsByNamed = Collections.emptyMap();
    private static Map<String, String> classByNamed = Collections.emptyMap();
    private static Map<String, String> classToNamed = Collections.emptyMap();

    // ── Intermediary (Fabric) — indexé directement depuis "official", sans détour ──
    private static Map<String, String> classOfficialToIntermediary = Collections.emptyMap();
    private static Map<String, String> classIntermediaryToNamed    = Collections.emptyMap();
    private static Map<String, String> methodOfficialToIntermediary = Collections.emptyMap(); // off.class\0off.name\0desc -> inter.name
    private static Map<String, Set<String>> methodOfficialNameToIntermediaryNames = Collections.emptyMap(); // off.class\0off.name -> {inter.name,...} (multi-overload)
    private static Map<String, String> fieldOfficialToIntermediary  = Collections.emptyMap(); // off.class\0off.name -> inter.name

    private YarnMappings() {}

    public static boolean isLoaded() { return loaded; }

    public static synchronized void load(InputStream is) throws IOException {
        Map<String, MethodEntry> methods   = new HashMap<>(65536);
        Map<String, MethodEntry> methodsAD = new HashMap<>(65536);
        Map<String, FieldEntry>  fields    = new HashMap<>(32768);
        Map<String, String>      classes   = new HashMap<>(8192);
        Map<String, String>      reverse   = new HashMap<>(8192);

        Map<String, String> classOffToInter        = new HashMap<>(8192);
        Map<String, String> classInterToNamed      = new HashMap<>(8192);
        Map<String, String> methodOffToInter       = new HashMap<>(65536);
        Map<String, Set<String>> methodOffNameToInter = new HashMap<>(65536);
        Map<String, String> fieldOffToInter         = new HashMap<>(32768);

        int colOfficial     = 0;
        int colIntermediary = 1;
        int colNamed        = 2;

        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(is, StandardCharsets.UTF_8))) {

            String line;
            boolean headerDone = false;
            String currentNamedClass = null;
            String currentOfficialClass = null;

            while ((line = br.readLine()) != null) {
                if (line.isEmpty()) continue;

                if (!headerDone) {
                    headerDone = true;
                    if (line.startsWith("tiny\t")) {
                        String[] h = line.split("\t");
                        for (int i = 3; i < h.length; i++) {
                            if ("official".equals(h[i]))     colOfficial     = i - 3;
                            if ("intermediary".equals(h[i])) colIntermediary = i - 3;
                            if ("named".equals(h[i]))        colNamed        = i - 3;
                        }
                    }
                    continue;
                }

                char first = line.charAt(0);

                if (first != '\t') {
                    currentNamedClass = null;
                    currentOfficialClass = null;
                    if (line.startsWith("c\t")) {
                        String[] p = line.substring(2).split("\t");
                        int maxCol = Math.max(colOfficial, Math.max(colIntermediary, colNamed));
                        if (p.length > maxCol) {
                            String namedCls    = p[colNamed];
                            String officialCls = p[colOfficial];
                            String interCls    = p[colIntermediary];
                            classes.put(namedCls, officialCls);
                            reverse.put(officialCls, namedCls);
                            classOffToInter.put(officialCls, interCls);
                            classInterToNamed.put(interCls, namedCls);
                            currentNamedClass = namedCls;
                            currentOfficialClass = officialCls;
                        }
                    }

                } else if (currentNamedClass != null) {
                    if (line.startsWith("\tm\t")) {
                        String[] p = line.substring(3).split("\t");
                        int nameColMax = 1 + Math.max(colOfficial, Math.max(colIntermediary, colNamed));
                        if (p.length > nameColMax) {
                            String desc          = p[0];
                            String officialName  = p[1 + colOfficial];
                            String interName     = p[1 + colIntermediary];
                            String namedName     = p[1 + colNamed];
                            MethodEntry me = new MethodEntry(officialName, desc);
                            methods.putIfAbsent(currentNamedClass + "\0" + namedName, me);
                            methodsAD.put(currentNamedClass + "\0" + namedName + "\0" + desc, me);

                            String offKey = currentOfficialClass + "\0" + officialName;
                            methodOffToInter.put(offKey + "\0" + desc, interName);
                            methodOffNameToInter.computeIfAbsent(offKey, k -> new HashSet<>()).add(interName);
                        }
                    } else if (line.startsWith("\tf\t")) {
                        String[] p = line.substring(3).split("\t");
                        int nameColMax = 1 + Math.max(colOfficial, Math.max(colIntermediary, colNamed));
                        if (p.length > nameColMax) {
                            String officialName = p[1 + colOfficial];
                            String interName    = p[1 + colIntermediary];
                            String namedName    = p[1 + colNamed];
                            fields.putIfAbsent(currentNamedClass + "\0" + namedName,
                                               new FieldEntry(officialName));
                            fieldOffToInter.put(currentOfficialClass + "\0" + officialName, interName);
                        }
                    }
                }
            }
        }

        methodsByNamed        = methods;
        methodsByNamedAndDesc = methodsAD;
        fieldsByNamed         = fields;
        classByNamed          = classes;
        classToNamed          = reverse;

        classOfficialToIntermediary           = classOffToInter;
        classIntermediaryToNamed              = classInterToNamed;
        methodOfficialToIntermediary          = methodOffToInter;
        methodOfficialNameToIntermediaryNames = methodOffNameToInter;
        fieldOfficialToIntermediary           = fieldOffToInter;

        loaded = true;
        LauncherLog.agent(3, "[Yarn] Chargé : " + classes.size() + " classes, "
                + methods.size() + " méthodes, " + fields.size() + " champs"
                + " (intermediary: " + classOffToInter.size() + " classes)");
    }

    public static synchronized void loadFromJar(String jarPath) throws IOException {
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(jarPath)) {
            java.util.zip.ZipEntry entry = zip.getEntry("mappings/mappings.tiny");
            if (entry == null)
                throw new IOException("mappings/mappings.tiny introuvable dans " + jarPath);
            load(zip.getInputStream(entry));
        }
    }

    public static MethodEntry getOfficialMethod(String namedClass, String namedMethod) {
        if (!loaded) return null;
        return methodsByNamed.get(namedClass + "\0" + namedMethod);
    }

    public static MethodEntry getOfficialMethod(String namedClass, String namedMethod,
                                                String officialDesc) {
        if (!loaded) return null;
        return methodsByNamedAndDesc.get(namedClass + "\0" + namedMethod + "\0" + officialDesc);
    }

    public static FieldEntry getOfficialField(String namedClass, String namedField) {
        if (!loaded) return null;
        return fieldsByNamed.get(namedClass + "\0" + namedField);
    }

    public static String getOfficialClass(String namedClass) {
        if (!loaded) return null;
        return classByNamed.get(namedClass);
    }

    public static String getNamedClass(String officialClass) {
        if (!loaded) return null;
        return classToNamed.get(officialClass);
    }

    public static Map<String, String> getAllClasses() {
        return Collections.unmodifiableMap(classByNamed);
    }

    // ── Intermediary (Fabric) ────────────────────────────────────────────────

    public static String getIntermediaryClass(String officialClass) {
        if (!loaded) return null;
        return classOfficialToIntermediary.get(officialClass);
    }

    public static String getNamedClassFromIntermediary(String intermediaryClass) {
        if (!loaded) return null;
        return classIntermediaryToNamed.get(intermediaryClass);
    }

    /** Nom intermediary exact pour un (classe officielle, nom officiel, descripteur officiel). */
    public static String getIntermediaryMethod(String officialClass, String officialMethod, String officialDesc) {
        if (!loaded) return null;
        return methodOfficialToIntermediary.get(officialClass + "\0" + officialMethod + "\0" + officialDesc);
    }

    /**
     * Tous les noms intermediary possibles pour (classe officielle, nom officiel),
     * sans descripteur — utile quand l'appelant filtre déjà par signature
     * (nombre/type de paramètres) après une recherche par nom, comme ScreenHelper.
     * Peut contenir plusieurs entrées si le nom officiel est surchargé.
     */
    public static Set<String> getIntermediaryMethodNames(String officialClass, String officialMethod) {
        if (!loaded) return Collections.emptySet();
        Set<String> s = methodOfficialNameToIntermediaryNames.get(officialClass + "\0" + officialMethod);
        return s != null ? s : Collections.emptySet();
    }

    public static String getIntermediaryField(String officialClass, String officialField) {
        if (!loaded) return null;
        return fieldOfficialToIntermediary.get(officialClass + "\0" + officialField);
    }
}
