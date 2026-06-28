package com.yuyuframe.launcheragent.agent;

import com.yuyuframe.launcheragent.mixin.service.LauncherMixinService;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry;
import com.yuyuframe.launcheragent.runtime.mapping.YarnMappings;
import org.spongepowered.asm.launch.MixinBootstrap;
import org.spongepowered.asm.mixin.MixinEnvironment;
import org.spongepowered.asm.mixin.Mixins;
import org.spongepowered.asm.mixin.extensibility.IMixinConfigSource;

import org.objectweb.asm.*;

import java.lang.instrument.Instrumentation;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Toute la logique qui touche Mixin/ASM — extraite de LauncherAgent pour
 * pouvoir être chargée soit normalement (vanilla/Forge, même classloader que
 * l'agent), soit via un classloader isolé dédié (Fabric — voir
 * LauncherAgent.premain()).
 *
 * Pourquoi l'isolation sous Fabric : MixinBootstrap/Mixins/MixinEnvironment
 * sont des singletons statiques par classe Java. Si CETTE classe (et donc
 * org.spongepowered.asm.* et MappingsRegistry/YarnMappings) est chargée par un
 * classloader séparé du classloader système (où vivent les classes de Fabric
 * Loader), elle obtient sa PROPRE copie indépendante de cet état statique —
 * GlobalProperties ne découvre alors plus le service Mixin de Fabric
 * (FabricGlobalPropertyService), qui causait le NPE/crash documentés dans
 * docs/LauncherAgent/index.md. Le ClassFileTransformer enregistré via
 * Instrumentation reste lui classloader-agnostique (le JVM l'appelle pour
 * toute classe définie, peu importe qui l'a chargée) — donc le tissage Mixin
 * sur les classes chargées par Fabric (KnotClassLoader) continue de
 * fonctionner sans jamais passer par le pipeline Mixin propre à Fabric.
 */
public final class IsolatedBootstrap {

    private IsolatedBootstrap() {}

    /**
     * @param fabric vrai si Fabric Loader est présent — déterminé par
     *               LauncherAgent (pas redétectable ici : sous isolation, le
     *               classloader de CETTE classe n'a justement pas accès aux
     *               classes de Fabric, donc toute détection locale échouerait
     *               systématiquement même quand Fabric est bien là).
     */
    public static void start(Instrumentation inst, String yarnPath, boolean fabric) {
        LauncherLog.agent(1, "[LauncherAgent] IsolatedBootstrap.start (classloader=" + IsolatedBootstrap.class.getClassLoader()
            + ", fabric=" + fabric + ")");

        // Doit être fixé avant tout usage de MappingsRegistry ci-dessous : sous
        // Fabric, les classes/méthodes/champs du jeu sont nommés "intermediary"
        // à l'exécution, pas "official" (obfusqué brut Mojang) — voir
        // MappingsRegistry.Scheme et docs/LauncherAgent/index.md.
        MappingsRegistry.setScheme(fabric
            ? MappingsRegistry.Scheme.INTERMEDIARY
            : MappingsRegistry.Scheme.OFFICIAL);

        // Doit être (re)fait ici, pas seulement dans LauncherAgent.premain() :
        // sous Fabric, cette classe (et donc LauncherMixinService) est chargée
        // par le classloader isolé — un objet DIFFÉRENT de celui que premain()
        // a configuré côté classloader système. Sans ça, le champ statique
        // Instrumentation de la copie isolée resterait null.
        LauncherMixinService.setInstrumentation(inst);

        loadYarnMappings(yarnPath);

        if (MappingsRegistry.isLoaded()) {
            String obfClass = MappingsRegistry.INSTANCE.map("net/minecraft/client/gui/screen/TitleScreen");
            LauncherLog.agent(1, "[LauncherAgent] Yarn TitleScreen → \"" + obfClass + "\""
                + (obfClass.equals("net/minecraft/client/gui/screen/TitleScreen") ? "  ← NON MAPPÉ" : "  ← OK"));
        }

        // Doit s'exécuter AVANT bootstrapMixin() (donc avant Mixins.addConfiguration) :
        // Mixin lit le refmap au moment où il prépare la config. Le dossier
        // "generated" est déjà sur le classpath isolé (ajouté par
        // LauncherAgent.startIsolated() avant la construction du classloader) —
        // il suffit d'y écrire le fichier pour qu'il devienne résolvable.
        if (fabric) writeRefmapFile();

        Set<String> mixinTargets = discoverMixinTargets();
        bootstrapMixin(inst, mixinTargets);
        scheduleDelayedRetransform(inst, mixinTargets);
    }

    /**
     * Écrit mixins.launcheragent.refmap.json dans <agentDir>/generated/ —
     * voir LauncherMixinService.buildRefmapJson() pour le contenu et
     * LauncherAgent.startIsolated() pour pourquoi ce dossier précis (déjà sur
     * le classpath du classloader isolé).
     */
    private static void writeRefmapFile() {
        try {
            java.io.File agentDir = agentDir();
            if (agentDir == null) {
                LauncherLog.err("[LauncherAgent] writeRefmapFile: dossier agent introuvable");
                return;
            }
            java.io.File dir = new java.io.File(agentDir, "generated");
            dir.mkdirs();
            java.io.File file = new java.io.File(dir, "mixins.launcheragent.refmap.json");
            String json = LauncherMixinService.buildRefmapJson();
            java.nio.file.Files.write(file.toPath(), json.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            LauncherLog.agent(1, "[LauncherAgent] refmap écrit : " + file + " = " + json);
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] writeRefmapFile: " + t);
        }
    }

    /** Dossier contenant ce JAR (et ses jars frères) — identique à LauncherAgent.agentDir(). */
    private static java.io.File agentDir() {
        try {
            java.net.URI uri = IsolatedBootstrap.class.getProtectionDomain()
                .getCodeSource().getLocation().toURI();
            return new java.io.File(uri).getParentFile();
        } catch (Exception e) {
            LauncherLog.err("[LauncherAgent] agentDir(): " + e);
            return null;
        }
    }

    /** @return true si le bootstrap a réussi. */
    private static boolean bootstrapMixin(Instrumentation inst, Set<String> mixinTargets) {
        try {
            MixinBootstrap.init();

            if (MappingsRegistry.isLoaded()) {
                MixinEnvironment.getDefaultEnvironment().getRemappers().add(MappingsRegistry.INSTANCE);
                LauncherLog.agent(1, "[LauncherAgent] Remappeur Mojang → obfusqué enregistré dans Mixin");
            }

            try {
                java.lang.reflect.Method gotoPhase = MixinEnvironment.class
                    .getDeclaredMethod("gotoPhase", MixinEnvironment.Phase.class);
                gotoPhase.setAccessible(true);
                gotoPhase.invoke(null, MixinEnvironment.Phase.DEFAULT);
                LauncherLog.agent(1, "[LauncherAgent] gotoPhase(DEFAULT) OK");
            } catch (Exception ex) {
                LauncherLog.warn("[LauncherAgent] gotoPhase(DEFAULT) erreur: " + ex);
            }

            Mixins.addConfiguration("mixins.launcheragent.json", (IMixinConfigSource) null);
            LauncherLog.agent(1, "[LauncherAgent] Config Mixin enregistrée");

            LauncherMixinService.installWrapper();

            try {
                java.lang.reflect.Method injectMethod =
                    MixinBootstrap.class.getDeclaredMethod("inject");
                injectMethod.setAccessible(true);
                injectMethod.invoke(null);
                LauncherLog.agent(1, "[LauncherAgent] MixinBootstrap.inject() OK");
            } catch (Exception ex) {
                LauncherLog.warn("[LauncherAgent] inject() non accessible: " + ex.getMessage());
            }

            retransformLoadedTargets(inst, mixinTargets);
            return true;
        } catch (Throwable e) {
            // Throwable, pas Exception : certains échecs Mixin (ex: MixinInitialisationError)
            // sont des Error, pas des Exception.
            LauncherLog.err("[LauncherAgent] ERREUR Mixin bootstrap : " + e.getMessage());
            e.printStackTrace(System.err);
            return false;
        }
    }

    private static void loadYarnMappings(String explicitPath) {
        if (explicitPath != null && !explicitPath.isEmpty()) {
            try {
                if (explicitPath.endsWith(".jar") || explicitPath.endsWith(".zip")) {
                    YarnMappings.loadFromJar(explicitPath);
                } else {
                    YarnMappings.load(new java.io.FileInputStream(explicitPath));
                }
                LauncherLog.agent(3, "[LauncherAgent] Yarn chargé depuis : " + explicitPath);
                return;
            } catch (Exception e) {
                LauncherLog.warn("[LauncherAgent] Yarn explicite non chargé (" + explicitPath + "): " + e.getMessage());
            }
        }

        String[] searchRoots = {
            System.getProperty("user.home") + "\\.gradle\\caches\\fabric-loom",
            System.getProperty("user.home") + "\\.gradle\\caches",
            System.getenv("APPDATA") != null ? System.getenv("APPDATA") + "\\.minecraft\\libraries" : null,
        };
        for (String root : searchRoots) {
            if (root == null) continue;
            java.io.File found = findYarnJar(new java.io.File(root), 0);
            if (found != null) {
                try {
                    YarnMappings.loadFromJar(found.getAbsolutePath());
                    LauncherLog.agent(3, "[LauncherAgent] Yarn auto-détecté : " + found.getAbsolutePath());
                    return;
                } catch (Exception e) {
                    LauncherLog.agent(1, "[LauncherAgent] Yarn auto-detect échec (" + found + "): " + e.getMessage());
                }
            }
        }

        try (java.io.InputStream is = IsolatedBootstrap.class.getResourceAsStream("/yarn-mappings.tiny")) {
            if (is != null) {
                YarnMappings.load(is);
                LauncherLog.agent(3, "[LauncherAgent] Yarn chargé depuis la resource JAR embarquée");
                return;
            }
        } catch (Exception e) {
            LauncherLog.agent(1, "[LauncherAgent] Yarn resource JAR non chargée : " + e.getMessage());
        }

        LauncherLog.warn("[LauncherAgent] Yarn non disponible — " +
            "passez yarn=<chemin vers yarn-X.X.X+build.Y-mergedv2.jar> en argument de l'agent");
    }

    private static java.io.File findYarnJar(java.io.File dir, int depth) {
        if (depth > 6 || !dir.isDirectory()) return null;
        java.io.File[] children = dir.listFiles();
        if (children == null) return null;
        for (java.io.File f : children) {
            if (f.isFile() && f.getName().contains("yarn") && f.getName().endsWith("-mergedv2.jar")) {
                return f;
            }
        }
        for (java.io.File f : children) {
            if (f.isDirectory()) {
                java.io.File r = findYarnJar(f, depth + 1);
                if (r != null) return r;
            }
        }
        return null;
    }

    private static Set<String> discoverMixinTargets() {
        Set<String> targets = new LinkedHashSet<>();
        Map<String, String> unmapped = new LinkedHashMap<>();
        try {
            ClassLoader agentCL = IsolatedBootstrap.class.getClassLoader();
            try (java.io.InputStream cfgIs = agentCL.getResourceAsStream("mixins.launcheragent.json")) {
                if (cfgIs == null) {
                    LauncherLog.err("[LauncherAgent] mixins.launcheragent.json introuvable");
                    return targets;
                }
                String json = new String(cfgIs.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                String pkg = jsonString(json, "package");
                if (pkg == null) return targets;

                for (String arrayKey : new String[]{"mixins", "client", "server"}) {
                    int keyIdx = json.indexOf("\"" + arrayKey + "\"");
                    if (keyIdx < 0) continue;
                    int arrStart = json.indexOf('[', keyIdx);
                    int arrEnd = json.indexOf(']', arrStart);
                    if (arrStart < 0 || arrEnd < 0) continue;

                    Matcher m = Pattern.compile("\"([A-Za-z][A-Za-z0-9$.]+)\"")
                            .matcher(json.substring(arrStart + 1, arrEnd));
                    while (m.find()) {
                        String entry = m.group(1);
                        String classRes = pkg.replace('.', '/') + "/" + entry.replace('.', '/') + ".class";
                        LauncherLog.agent(1, "[LauncherAgent] Scan bytecode [" + arrayKey + "]: " + entry);
                        try (java.io.InputStream cls = agentCL.getResourceAsStream(classRes)) {
                            if (cls == null) {
                                LauncherLog.warn("[LauncherAgent]   → .class introuvable: " + classRes);
                                unmapped.put(entry, ".class introuvable dans le JAR (" + classRes + ")");
                                continue;
                            }
                            targets.addAll(extractMixinTargets(cls.readAllBytes(), entry, unmapped));
                        } catch (Throwable e) {
                            LauncherLog.err("[LauncherAgent]   → ERREUR " + entry + ": " + e);
                            unmapped.put(entry, "exception au scan : " + e);
                        }
                    }
                }
            }
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] discoverMixinTargets erreur: " + t);
        }
        LauncherLog.agent(3, "[LauncherAgent] " + targets.size() + " cible(s) Mixin: " + targets);

        if (!unmapped.isEmpty()) {
            StringBuilder sb = new StringBuilder("Résolution Yarn→obfusqué échouée pour ");
            sb.append(unmapped.size()).append(" Mixin(s) :\n");
            for (Map.Entry<String, String> e : unmapped.entrySet()) {
                sb.append("  - ").append(e.getKey()).append(" : ").append(e.getValue()).append('\n');
            }
            sb.append("Vérifiez que la version de Yarn chargée correspond à la version de Minecraft lancée.");
            throw LauncherLog.fatal("[LauncherAgent] " + sb);
        }

        return targets;
    }

    private static Set<String> extractMixinTargets(byte[] classBytes, String simpleName,
                                                     Map<String, String> unmapped) {
        Set<String> result = new LinkedHashSet<>();
        new ClassReader(classBytes).accept(new ClassVisitor(Opcodes.ASM9) {
            @Override
            public AnnotationVisitor visitAnnotation(String desc, boolean visible) {
                if (!desc.equals("Lorg/spongepowered/asm/mixin/Mixin;")) return null;
                return new AnnotationVisitor(Opcodes.ASM9) {
                    @Override
                    public AnnotationVisitor visitArray(String name) {
                        if (name.equals("value")) {
                            return new AnnotationVisitor(Opcodes.ASM9) {
                                @Override public void visit(String n, Object val) {
                                    if (!(val instanceof Type)) return;
                                    String slash = ((Type) val).getInternalName();
                                    String obf = MappingsRegistry.INSTANCE.map(slash);
                                    result.add(obf.replace('/', '.'));
                                    LauncherLog.agent(1, "[LauncherAgent]   → " + simpleName
                                            + " value: " + slash + " → " + obf.replace('/', '.'));
                                    checkMapped(simpleName, slash, obf, unmapped);
                                }
                            };
                        }
                        if (name.equals("targets")) {
                            return new AnnotationVisitor(Opcodes.ASM9) {
                                @Override public void visit(String n, Object val) {
                                    if (!(val instanceof String)) return;
                                    String slash = ((String) val).replace('.', '/');
                                    String obf = MappingsRegistry.INSTANCE.map(slash);
                                    result.add(obf.replace('/', '.'));
                                    LauncherLog.agent(1, "[LauncherAgent]   → " + simpleName
                                            + " targets: " + val + " → " + obf.replace('/', '.'));
                                    checkMapped(simpleName, slash, obf, unmapped);
                                }
                            };
                        }
                        return null;
                    }
                };
            }
        }, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
        if (result.isEmpty()) {
            LauncherLog.warn("[LauncherAgent]   → WARN: aucune cible trouvée dans " + simpleName);
            unmapped.put(simpleName, "aucune cible @Mixin(value/targets) trouvée dans le bytecode");
        }
        return result;
    }

    private static void checkMapped(String simpleName, String yarnSlash, String obfSlash,
                                      Map<String, String> unmapped) {
        if (MappingsRegistry.isLoaded() && yarnSlash.equals(obfSlash)) {
            unmapped.put(simpleName + " → " + yarnSlash.replace('/', '.'),
                "aucune entrée Yarn pour cette classe (mapping inchangé)");
        }
    }

    private static String jsonString(String json, String key) {
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) return null;
        i = json.indexOf('"', json.indexOf(':', i) + 1);
        if (i < 0) return null;
        int end = json.indexOf('"', i + 1);
        return end > i ? json.substring(i + 1, end) : null;
    }

    private static void retransformLoadedTargets(Instrumentation inst, Set<String> targets) {
        if (targets.isEmpty()) return;
        int count = 0;
        for (Class<?> cls : inst.getAllLoadedClasses()) {
            if (!targets.contains(cls.getName())) continue;
            boolean modifiable = inst.isModifiableClass(cls);
            LauncherLog.agent(1, "[LauncherAgent] Retransform immédiat: " + cls.getName()
                    + " | modifiable=" + modifiable);
            if (!modifiable) continue;
            try {
                inst.retransformClasses(cls);
                count++;
            } catch (Throwable ex) {
                LauncherLog.err("[LauncherAgent] Retransform " + cls.getName() + " erreur: " + ex);
            }
        }
        LauncherLog.agent(3, "[LauncherAgent] Retransformations immédiates: " + count + "/" + targets.size());
    }

    private static void scheduleDelayedRetransform(Instrumentation inst, Set<String> targets) {
        if (targets.isEmpty()) return;
        Thread t = new Thread(() -> {
            Set<String> remaining = new LinkedHashSet<>(targets);
            long deadline = System.currentTimeMillis() + 30_000;
            while (!remaining.isEmpty() && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
                for (Class<?> cls : inst.getAllLoadedClasses()) {
                    if (!remaining.remove(cls.getName())) continue;
                    int alreadyHooks = countHooks(cls);
                    if (alreadyHooks > 0) {
                        LauncherLog.agent(1, "[LauncherAgent] Cible déjà mixée (initial load): "
                                + cls.getName() + " — skip retransform");
                        continue;
                    }
                    boolean mod = inst.isModifiableClass(cls);
                    LauncherLog.agent(1, "[LauncherAgent] Retransform différé: " + cls.getName()
                            + " | modifiable=" + mod);
                    if (!mod) continue;
                    try {
                        inst.retransformClasses(cls);
                    } catch (Throwable ex) {
                        LauncherLog.err("[LauncherAgent] Retransform " + cls.getName() + " erreur: " + ex);
                    }
                }
            }
            if (!remaining.isEmpty()) {
                LauncherLog.warn("[LauncherAgent] cibles jamais chargées: " + remaining);
            }
            LauncherLog.agent(1, "[LauncherAgent] Thread retransform terminé");
        }, "LauncherAgent-Retransform");
        t.setDaemon(true);
        t.start();
    }

    private static int countHooks(Class<?> cls) {
        int n = 0;
        for (java.lang.reflect.Method m : cls.getDeclaredMethods())
            if (m.getName().startsWith("la$")) n++;
        return n;
    }
}
