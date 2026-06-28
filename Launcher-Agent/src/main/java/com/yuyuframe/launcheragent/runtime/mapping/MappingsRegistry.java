package com.yuyuframe.launcheragent.runtime.mapping;

import org.spongepowered.asm.mixin.extensibility.IRemapper;

import java.util.Set;

/**
 * Registre de mappings fondé sur Yarn tiny v2 — copie indépendante de celle
 * du p2p-agent (voir [[YarnMappings]] pour la raison de la duplication).
 *
 * IRemapper pour Mixin :
 *   map(yarnNamed)       → classe runtime  (résolution de @Mixin(targets = "..."))
 *   unmap(classe runtime) → yarnNamed      (pour getClassNode())
 *
 * Scheme : sous Fabric, les classes/méthodes/champs du jeu sont nommés
 * "intermediary" à l'exécution (ex: method_25426), pas "official" (les noms
 * obfusqués bruts de Mojang, ex: bg_) comme en vanilla. {@link #setScheme}
 * doit être appelé une fois (selon que Fabric est détecté ou non) avant tout
 * usage — voir IsolatedBootstrap. Tout le reste de ce registre (et donc tout
 * code qui passe par lui : Mixin, ScreenHelper, IconWidgets) devient alors
 * automatiquement cohérent avec le schéma actif.
 */
public final class MappingsRegistry implements IRemapper {

    public static final MappingsRegistry INSTANCE = new MappingsRegistry();
    private MappingsRegistry() {}

    public enum Scheme { OFFICIAL, INTERMEDIARY }

    private static volatile Scheme scheme = Scheme.OFFICIAL;

    public static void setScheme(Scheme s) { scheme = s; }
    public static Scheme getScheme() { return scheme; }

    public static boolean isLoaded() { return YarnMappings.isLoaded(); }

    private static volatile boolean autoInitAttempted = false;

    /**
     * Sous Fabric, le code tissé par Mixin (les corps de méthode @Inject) est
     * résolu par KnotClassLoader — qui charge
     * "com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry" comme une
     * classe SÉPARÉE de celle utilisée par IsolatedBootstrap (chargée, elle,
     * via le classloader isolé dédié à Mixin/ASM). Deux classloaders
     * différents chargeant "la même" classe produisent deux objets Class
     * indépendants, donc deux états statiques indépendants : cette copie n'a
     * jamais reçu setScheme()/YarnMappings.load() — d'où "scheme" resté à
     * OFFICIAL (sa valeur par défaut) malgré le fait que le bootstrap a bien
     * configuré l'AUTRE copie. Seule une System property (table globale,
     * indépendante des classloaders) traverse cette frontière — voir
     * LauncherAgent.premain(). Appelé paresseusement par toutes les méthodes
     * de traduction ci-dessous : sans coût une fois isLoaded()==true.
     */
    private static void ensureInitialized() {
        if (YarnMappings.isLoaded() || autoInitAttempted) return;
        autoInitAttempted = true;
        try {
            boolean fabric = "true".equals(System.getProperty("launcheragent.fabric"));
            scheme = fabric ? Scheme.INTERMEDIARY : Scheme.OFFICIAL;
            String yarnPath = System.getProperty("launcheragent.yarnPath");
            if (yarnPath == null || yarnPath.isEmpty()) return;
            if (yarnPath.endsWith(".jar") || yarnPath.endsWith(".zip")) {
                YarnMappings.loadFromJar(yarnPath);
            } else {
                try (java.io.FileInputStream fis = new java.io.FileInputStream(yarnPath)) {
                    YarnMappings.load(fis);
                }
            }
        } catch (Exception ignored) {}
    }

    // ── Official → runtime (officiel en vanilla, intermediary sous Fabric) ──────

    private static String officialToRuntimeClass(String officialClass) {
        ensureInitialized();
        if (scheme == Scheme.INTERMEDIARY) {
            String inter = YarnMappings.getIntermediaryClass(officialClass);
            if (inter != null) return inter;
        }
        return officialClass;
    }

    /**
     * Traduit un descripteur de méthode/constructeur ÉCRIT EN OFFICIAL (ex:
     * "(Lgsb;Lgfo;)V") vers sa forme runtime (slash, comme stocké côté
     * intermediary) — nécessaire pour construire la valeur d'une entrée de
     * refmap visant un constructeur ou toute méthode dont le descripteur
     * référence des types d'objets : le nom "<init>" ne change jamais, mais
     * les TYPES dans le descripteur si, sous Fabric. Contrairement à
     * {@link #mapDesc} (IRemapper, attend du "named"), celui-ci attend
     * directement de l'official — pas de détour par YarnMappings.getOfficialClass().
     */
    public static String runtimeDesc(String officialDesc) {
        StringBuilder sb = new StringBuilder(officialDesc.length());
        int i = 0;
        while (i < officialDesc.length()) {
            char c = officialDesc.charAt(i++);
            if (c == 'L') {
                int semi = officialDesc.indexOf(';', i);
                if (semi < 0) { sb.append('L').append(officialDesc.substring(i)); break; }
                String cls = officialDesc.substring(i, semi);
                sb.append('L').append(officialToRuntimeClass(cls)).append(';');
                i = semi + 1;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** Champ : nom officiel littéral écrit en dur dans le code de réflexion → nom runtime. */
    public static String runtimeField(String officialClass, String officialField) {
        ensureInitialized();
        if (scheme == Scheme.INTERMEDIARY && isLoaded()) {
            String inter = YarnMappings.getIntermediaryField(officialClass, officialField);
            if (inter != null) return inter;
        }
        return officialField;
    }

    /** Méthode (avec descripteur officiel exact) : nom officiel → nom runtime. */
    public static String runtimeMethod(String officialClass, String officialMethod, String officialDesc) {
        ensureInitialized();
        if (scheme == Scheme.INTERMEDIARY && isLoaded()) {
            String inter = YarnMappings.getIntermediaryMethod(officialClass, officialMethod, officialDesc);
            if (inter != null) return inter;
        }
        return officialMethod;
    }

    /**
     * Méthode sans descripteur connu à l'avance — renvoie tous les noms runtime
     * possibles (généralement 1, plusieurs si le nom officiel est surchargé).
     * À utiliser quand l'appelant filtre déjà par signature après le nom (cas
     * fréquent dans ScreenHelper) : remplacer {@code "x".equals(m.getName())}
     * par {@code runtimeMethodNames("Class","x").contains(m.getName())}.
     */
    public static Set<String> runtimeMethodNames(String officialClass, String officialMethod) {
        ensureInitialized();
        if (scheme == Scheme.INTERMEDIARY && isLoaded()) {
            Set<String> names = YarnMappings.getIntermediaryMethodNames(officialClass, officialMethod);
            if (!names.isEmpty()) return names;
        }
        return Set.of(officialMethod);
    }

    /**
     * Classe : nom officiel littéral (ex: "gjc") → nom runtime, format à POINTS
     * (binary name) — tous les appelants (ScreenHelper, IconWidgets) l'utilisent
     * directement avec Class.forName()/getName(), qui exigent des points, pas
     * des slashes. officialToRuntimeClass() (interne, utilisé par map() pour
     * Mixin/ASM) renvoie lui du slash form — converti ici uniquement pour ce
     * point d'entrée public.
     */
    public static String runtimeClass(String officialClass) {
        return officialToRuntimeClass(officialClass).replace('/', '.');
    }

    // ── Named (Yarn) ↔ runtime — utilisé par discoverMixinTargets/ScreenStubPatcher ──

    /**
     * Toujours "official", jamais "intermediary" — pour la lecture de
     * bytecode DEPUIS LE DISQUE (getClassNode) : le jar Minecraft réel sur le
     * classpath (toujours présent, même sous Fabric — Fabric en a besoin comme
     * source pour son propre remapping) contient les classes sous leur nom
     * "official" brut. Les noms "intermediary" n'existent eux QU'EN MÉMOIRE,
     * générés par Fabric au chargement — aucune entrée de fichier ne porte ce
     * nom dans aucun jar, donc une lecture-disque avec un nom intermediary
     * échoue TOUJOURS, quelle que soit l'isolation de classloader. Utiliser
     * {@link #map} (scheme-aware) pour la correspondance runtime, et CETTE
     * méthode pour toute lecture statique de fichier .class.
     */
    public static String getOfficialClassAlways(String yarnClass) {
        String obf = YarnMappings.getOfficialClass(yarnClass);
        return obf != null ? obf : yarnClass;
    }

    public static String getObfClassDot(String yarnClass) {
        String obf = YarnMappings.getOfficialClass(yarnClass);
        if (obf == null) return yarnClass.replace('/', '.');
        return officialToRuntimeClass(obf).replace('/', '.');
    }

    public static Class<?> loadClass(String yarnClass) throws ClassNotFoundException {
        String name = getObfClassDot(yarnClass);
        ClassLoader ctx = Thread.currentThread().getContextClassLoader();
        if (ctx != null) {
            try { return Class.forName(name, false, ctx); } catch (ClassNotFoundException ignored) {}
        }
        try {
            return Class.forName(name);
        } catch (ClassNotFoundException e) {
            String fallback = yarnClass.replace('/', '.');
            if (!fallback.equals(name)) {
                if (ctx != null) {
                    try { return Class.forName(fallback, false, ctx); } catch (ClassNotFoundException ignored) {}
                }
                return Class.forName(fallback);
            }
            throw e;
        }
    }

    public static boolean isInstance(Object obj, String yarnClass) {
        if (obj == null) return false;
        try {
            return loadClass(yarnClass).isInstance(obj);
        } catch (ClassNotFoundException e) {
            String simpleName = yarnClass.substring(yarnClass.lastIndexOf('/') + 1);
            return obj.getClass().getName().contains(simpleName);
        }
    }

    public static String getObfMethodName(String yarnClass, String yarnMethod) {
        if (!isLoaded()) return yarnMethod;
        YarnMappings.MethodEntry entry = YarnMappings.getOfficialMethod(yarnClass, yarnMethod);
        if (entry == null) return yarnMethod;
        if (scheme == Scheme.INTERMEDIARY) {
            String officialOwner = YarnMappings.getOfficialClass(yarnClass);
            if (officialOwner != null) {
                String inter = YarnMappings.getIntermediaryMethod(officialOwner, entry.officialName, entry.officialDesc);
                if (inter != null) return inter;
            }
        }
        return entry.officialName;
    }

    public static String getObfFieldName(String yarnClass, String yarnField) {
        if (!isLoaded()) return yarnField;
        YarnMappings.FieldEntry entry = YarnMappings.getOfficialField(yarnClass, yarnField);
        if (entry == null) return yarnField;
        if (scheme == Scheme.INTERMEDIARY) {
            String officialOwner = YarnMappings.getOfficialClass(yarnClass);
            if (officialOwner != null) {
                String inter = YarnMappings.getIntermediaryField(officialOwner, entry.officialName);
                if (inter != null) return inter;
            }
        }
        return entry.officialName;
    }

    /** Runtime (official ou intermediary selon le schéma actif) → named (Yarn). */
    private static String runtimeToNamed(String runtimeClass) {
        if (scheme == Scheme.INTERMEDIARY) {
            String named = YarnMappings.getNamedClassFromIntermediary(runtimeClass);
            return named != null ? named : runtimeClass;
        }
        String named = YarnMappings.getNamedClass(runtimeClass);
        return named != null ? named : runtimeClass;
    }

    // ── IRemapper (Mixin) ────────────────────────────────────────────────────

    @Override
    public String map(String typeName) {
        if (!isLoaded() || typeName == null) return typeName;
        String obf = YarnMappings.getOfficialClass(typeName);
        if (obf == null) return typeName;
        return officialToRuntimeClass(obf);
    }

    @Override
    public String unmap(String typeName) {
        if (!isLoaded() || typeName == null) return typeName;
        return runtimeToNamed(typeName);
    }

    @Override
    public String mapMethodName(String owner, String name, String desc) {
        if (!isLoaded() || name == null) return name;
        String namedOwner = runtimeToNamed(owner);
        YarnMappings.MethodEntry entry = YarnMappings.getOfficialMethod(namedOwner, name);
        if (entry == null) return name;
        if (scheme == Scheme.INTERMEDIARY) {
            String officialOwner = YarnMappings.getOfficialClass(namedOwner);
            if (officialOwner != null) {
                String inter = YarnMappings.getIntermediaryMethod(officialOwner, entry.officialName, entry.officialDesc);
                if (inter != null) return inter;
            }
        }
        return entry.officialName;
    }

    @Override
    public String mapFieldName(String owner, String name, String desc) {
        if (!isLoaded() || name == null) return name;
        String namedOwner = runtimeToNamed(owner);
        YarnMappings.FieldEntry entry = YarnMappings.getOfficialField(namedOwner, name);
        if (entry == null) return name;
        if (scheme == Scheme.INTERMEDIARY) {
            String officialOwner = YarnMappings.getOfficialClass(namedOwner);
            if (officialOwner != null) {
                String inter = YarnMappings.getIntermediaryField(officialOwner, entry.officialName);
                if (inter != null) return inter;
            }
        }
        return entry.officialName;
    }

    @Override
    public String mapDesc(String desc) {
        if (!isLoaded() || desc == null) return desc;
        return remapDesc(desc, true);
    }

    @Override
    public String unmapDesc(String desc) {
        if (!isLoaded() || desc == null) return desc;
        return remapDesc(desc, false);
    }

    private static String remapDesc(String desc, boolean namedToRuntime) {
        StringBuilder sb = new StringBuilder(desc.length());
        int i = 0;
        while (i < desc.length()) {
            char c = desc.charAt(i++);
            if (c == 'L') {
                int semi = desc.indexOf(';', i);
                if (semi < 0) { sb.append('L').append(desc.substring(i)); break; }
                String cls = desc.substring(i, semi);
                String mapped;
                if (namedToRuntime) {
                    String obf = YarnMappings.getOfficialClass(cls);
                    mapped = obf != null ? officialToRuntimeClass(obf) : cls;
                } else {
                    mapped = runtimeToNamed(cls);
                }
                sb.append('L').append(mapped).append(';');
                i = semi + 1;
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
