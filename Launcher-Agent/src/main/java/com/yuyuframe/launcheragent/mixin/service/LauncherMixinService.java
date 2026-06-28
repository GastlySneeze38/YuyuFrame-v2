package com.yuyuframe.launcheragent.mixin.service;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry;
import com.yuyuframe.launcheragent.runtime.mapping.YarnMappings;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.tree.ClassNode;
import org.spongepowered.asm.launch.platform.container.IContainerHandle;
import org.spongepowered.asm.logging.ILogger;
import org.spongepowered.asm.mixin.MixinEnvironment;
import org.spongepowered.asm.mixin.transformer.IMixinTransformer;
import org.spongepowered.asm.mixin.transformer.IMixinTransformerFactory;
import org.spongepowered.asm.service.*;
import org.spongepowered.asm.util.ReEntranceLock;

import java.lang.instrument.Instrumentation;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.Collection;
import java.util.Collections;

/**
 * Service Mixin standalone pour LauncherAgent — sans LaunchWrapper/ModLauncher.
 * Enregistré via META-INF/services, sélectionné car isValid() = true.
 *
 * Copie indépendante de com.p2pminecraft.mixin.service.P2PMixinService :
 * même plomberie, mais aucune classe partagée avec le p2p-agent.
 */
public class LauncherMixinService implements IMixinService, IClassProvider, IClassBytecodeProvider {

    private static volatile Instrumentation savedInst;
    private static volatile IMixinTransformer storedTransformer;

    public static void setInstrumentation(Instrumentation inst) {
        savedInst = inst;
    }

    public static Instrumentation getInstrumentation() { return savedInst; }

    private final ReEntranceLock lock = new ReEntranceLock(1);
    private final IContainerHandle container =
        new LauncherContainerHandle("launcher-agent", "YuyuFrame LauncherAgent");

    @Override public String getName()  { return "LauncherJavaAgent"; }
    @Override public boolean isValid() { return true; }
    @Override public void prepare()    {}
    @Override public void init()       {}
    @Override public void beginPhase() {}

    @Override
    public void offer(IMixinInternal internal) {
        if (!(internal instanceof IMixinTransformerFactory)) return;
        try {
            storedTransformer = ((IMixinTransformerFactory) internal).createTransformer();
            LauncherLog.asm(1, "[LauncherAgent] offer() : transformer stocké, wrapper installé plus tard");
        } catch (Exception e) {
            LauncherLog.err("[LauncherAgent] Erreur offer(): " + e.getMessage());
            e.printStackTrace(System.err);
        }
    }

    /** Appelé explicitement par LauncherAgent.premain() APRÈS mappings + addConfiguration(). */
    public static void installWrapper() {
        if (savedInst == null) { LauncherLog.err("[LauncherAgent] installWrapper: savedInst null"); return; }
        if (storedTransformer == null) { LauncherLog.err("[LauncherAgent] installWrapper: storedTransformer null"); return; }
        try {
            savedInst.addTransformer(new LauncherMixinTransformerWrapper(storedTransformer), true);
            LauncherLog.asm(3, "[LauncherAgent] Wrapper installé (mappings+config prêts, canRetransform=true)");
        } catch (Exception e) {
            LauncherLog.err("[LauncherAgent] installWrapper() erreur: " + e);
        }
    }

    @Override public void checkEnv(Object bootSource) {}

    @Override
    public MixinEnvironment.Phase getInitialPhase() {
        return MixinEnvironment.Phase.DEFAULT;
    }

    @Override public ReEntranceLock getReEntranceLock()     { return lock; }
    @Override public IClassProvider getClassProvider()      { return this; }
    @Override public IClassBytecodeProvider getBytecodeProvider() { return this; }
    @Override public ITransformerProvider getTransformerProvider() { return null; }
    @Override public IClassTracker getClassTracker()        { return null; }
    @Override public IMixinAuditTrail getAuditTrail()       { return null; }

    @Override
    public Collection<String> getPlatformAgents() { return Collections.emptyList(); }

    @Override
    public IContainerHandle getPrimaryContainer() { return container; }

    @Override
    public Collection<IContainerHandle> getMixinContainers() {
        return Collections.emptyList();
    }

    @Override
    public InputStream getResourceAsStream(String name) {
        ClassLoader cl = getContextClassLoader();
        InputStream is = cl.getResourceAsStream(name);
        if (is == null) {
            cl = LauncherMixinService.class.getClassLoader();
            is = cl.getResourceAsStream(name);
        }
        return is;
    }

    /**
     * Une entrée = un @Inject(method="...") à traduire dans le refmap.
     * {@code fallbackOfficialOwner} : classe "official" courte vers laquelle
     * replier la recherche quand la méthode est héritée/surchargée sans entrée
     * Yarn propre à la sous-classe (ex: "bg_"/init() n'est documenté que sur
     * Screen lui-même, "gsb") — {@code null} si la méthode est déclarée
     * directement sur la classe cible (pas de repli pertinent).
     */
    private record RefmapEntry(String mixinInternalName, String yarnTargetClass,
                                String officialMethod, String officialDesc, String fallbackOfficialOwner) {}

    private static final RefmapEntry[] REFMAP_ENTRIES = {
        new RefmapEntry("com/yuyuframe/launcheragent/mixin/client/TitleScreenMixin",
            "net/minecraft/client/gui/screen/TitleScreen", "bg_", "()V", "gsb"),
        new RefmapEntry("com/yuyuframe/launcheragent/mixin/client/PackScreenMixin",
            "net/minecraft/client/gui/screen/pack/PackScreen", "bg_", "()V", "gsb"),
        // GameMenuScreen (menu pause) n'override pas bg_()/init() directement —
        // depuis le passage à GridWidget, Screen.init() appelle initWidgets()
        // (official "F", déclaré directement sur GameMenuScreen) ; pas de repli
        // Screen pertinent ici puisque la méthode n'y existe pas.
        new RefmapEntry("com/yuyuframe/launcheragent/mixin/client/GameMenuScreenMixin",
            "net/minecraft/client/gui/screen/GameMenuScreen", "F", "()V", null),
        // "<init>" n'est jamais renommé (aucune entrée de nom à traduire), mais
        // son descripteur référence Screen/GameOptions ("Lgsb;Lgfo;") — ces
        // TYPES doivent être traduits sous Fabric (voir MappingsRegistry.runtimeDesc).
        new RefmapEntry("com/yuyuframe/launcheragent/mixin/client/KeybindsScreenMixin",
            "net/minecraft/client/gui/screen/option/KeybindsScreen", "<init>", "(Lgsb;Lgfo;)V", null),
    };

    /**
     * Construit le JSON du refmap Mixin (official→intermediary) pour nos
     * @Inject(method="...", ...). Écrit dans un VRAI fichier par l'appelant
     * (IsolatedBootstrap) — l'interception de {@link #getResourceAsStream}
     * pour ce nom précis ne fonctionnait pas : Mixin 0.8.7 charge visiblement
     * son refmap par un autre chemin que IMixinService.getResourceAsStream()
     * (probablement directement via un classloader), donc le seul moyen fiable
     * est de rendre le fichier réellement résolvable par CE classloader.
     *
     * En vanilla (scheme OFFICIAL), l'appelant n'écrit aucun fichier du tout —
     * Mixin retombe alors sur la chaîne littérale official inchangée (warning
     * "No refMap loaded", non fatal) — comportement déjà validé, aucune
     * régression.
     */
    public static String buildRefmapJson() {
        // Groupé par mixin : un même mixin peut avoir PLUSIEURS @Inject à
        // traduire — il faut une seule clé JSON par mixin, avec toutes ses
        // entrées de méthode fusionnées dans le même objet interne, sinon la
        // seconde écraserait la première dans le JSON final.
        java.util.Map<String, java.util.Map<String, String>> byMixin = new java.util.LinkedHashMap<>();
        for (RefmapEntry e : REFMAP_ENTRIES) {
            String replacement = refmapMethodReplacement(
                e.yarnTargetClass(), e.officialMethod(), e.officialDesc(), e.fallbackOfficialOwner());
            byMixin.computeIfAbsent(e.mixinInternalName(), k -> new java.util.LinkedHashMap<>())
                   .put(e.officialMethod() + e.officialDesc(), replacement);
        }

        StringBuilder sb = new StringBuilder("{\"mappings\":{");
        boolean firstMixin = true;
        for (var mixinEntry : byMixin.entrySet()) {
            if (!firstMixin) sb.append(',');
            firstMixin = false;
            sb.append('"').append(mixinEntry.getKey()).append("\":{");
            boolean firstMethod = true;
            for (var methodEntry : mixinEntry.getValue().entrySet()) {
                if (!firstMethod) sb.append(',');
                firstMethod = false;
                sb.append('"').append(methodEntry.getKey()).append("\":\"").append(methodEntry.getValue()).append('"');
            }
            sb.append('}');
        }
        sb.append("}}");
        return sb.toString();
    }

    /**
     * "<intermediary ou fallback official>()desc" pour une entrée de refmap.
     * Cherche d'abord dans la classe cible elle-même (ex: TitleScreen), puis
     * dans {@code fallbackOfficialOwner} si non-null — certaines méthodes
     * (ex: "bg_"/init()) ne sont documentées par Yarn que sur la classe qui les
     * déclare à l'origine (Screen), pas sur chaque sous-classe qui se contente
     * de surcharger sans changer la signature.
     */
    private static String refmapMethodReplacement(String yarnClass, String officialMethod, String officialDesc,
                                                     String fallbackOfficialOwner) {
        String officialClass = YarnMappings.getOfficialClass(yarnClass);
        String inter = officialClass != null
            ? YarnMappings.getIntermediaryMethod(officialClass, officialMethod, officialDesc)
            : null;
        if (inter == null && fallbackOfficialOwner != null) {
            inter = YarnMappings.getIntermediaryMethod(fallbackOfficialOwner, officialMethod, officialDesc);
        }
        LauncherLog.asm(1, "[LauncherAgent] refmap: " + yarnClass + " " + officialMethod + officialDesc
            + " → " + inter);
        // runtimeDesc() : no-op pour les descripteurs sans type objet (ex:
        // "()V" des écrans existants), traduit "Lgsb;Lgfo;" → intermediary
        // pour les nouvelles entrées qui en ont besoin (ex: constructeurs).
        return (inter != null ? inter : officialMethod) + MappingsRegistry.runtimeDesc(officialDesc);
    }

    @Override public String getSideName() { return "CLIENT"; }

    @Override
    public MixinEnvironment.CompatibilityLevel getMinCompatibilityLevel() { return null; }

    @Override
    public MixinEnvironment.CompatibilityLevel getMaxCompatibilityLevel() { return null; }

    @Override
    public ILogger getLogger(String name) { return new LauncherLogger(name); }

    // ── IClassProvider ────────────────────────────────────────────────────────

    @Override
    public Class<?> findClass(String name) throws ClassNotFoundException {
        return Class.forName(name, false, getContextClassLoader());
    }

    @Override
    public Class<?> findClass(String name, boolean initialize) throws ClassNotFoundException {
        return Class.forName(name, initialize, getContextClassLoader());
    }

    @Override
    public Class<?> findAgentClass(String name, boolean initialize) throws ClassNotFoundException {
        return Class.forName(name, initialize, LauncherMixinService.class.getClassLoader());
    }

    @Override
    public URL[] getClassPath() { return new URL[0]; }

    // ── IClassBytecodeProvider ────────────────────────────────────────────────

    @Override
    public ClassNode getClassNode(String name) throws ClassNotFoundException, IOException {
        return getClassNode(name, false, 0);
    }

    @Override
    public ClassNode getClassNode(String name, boolean runTransformers)
            throws ClassNotFoundException, IOException {
        return getClassNode(name, runTransformers, 0);
    }

    @Override
    public ClassNode getClassNode(String name, boolean runTransformers, int readerFlags)
            throws ClassNotFoundException, IOException {
        String nameSlash = name.replace('.', '/');
        String resource = nameSlash + ".class";

        ClassLoader cl = getContextClassLoader();
        InputStream is = cl.getResourceAsStream(resource);
        if (is == null) {
            cl = LauncherMixinService.class.getClassLoader();
            is = cl.getResourceAsStream(resource);
        }

        String obfSlash = nameSlash;
        if (is == null && MappingsRegistry.isLoaded()) {
            // Toujours "official" ici, jamais le schéma actif (intermediary
            // sous Fabric) — cette lecture cherche un VRAI fichier .class sur
            // le classpath, et seul le nom official correspond à une entrée
            // réelle dans le jar Minecraft (toujours présent même sous Fabric,
            // qui en a besoin comme source de remapping) — voir
            // MappingsRegistry.getOfficialClassAlways().
            obfSlash = MappingsRegistry.getOfficialClassAlways(nameSlash);
            if (!obfSlash.equals(nameSlash)) {
                String obfResource = obfSlash + ".class";
                cl = getContextClassLoader();
                is = cl.getResourceAsStream(obfResource);
                if (is == null) {
                    cl = LauncherMixinService.class.getClassLoader();
                    is = cl.getResourceAsStream(obfResource);
                }
            }
        }

        if (is == null) throw new ClassNotFoundException(name);

        try {
            ClassReader cr = new ClassReader(is);
            ClassNode cn = new ClassNode();
            cr.accept(cn, readerFlags == 0 ? ClassReader.EXPAND_FRAMES : readerFlags);
            if (!obfSlash.equals(nameSlash)) {
                cn.name = nameSlash;
            }
            return cn;
        } finally {
            is.close();
        }
    }

    private static ClassLoader getContextClassLoader() {
        ClassLoader cl = Thread.currentThread().getContextClassLoader();
        return cl != null ? cl : ClassLoader.getSystemClassLoader();
    }
}
