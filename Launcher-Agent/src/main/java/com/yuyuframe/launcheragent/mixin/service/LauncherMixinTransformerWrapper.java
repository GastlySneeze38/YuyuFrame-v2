package com.yuyuframe.launcheragent.mixin.service;

import com.yuyuframe.launcheragent.mixin.service.transformer.ScreenStubPatcher;
import org.spongepowered.asm.mixin.transformer.IMixinTransformer;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;

/**
 * Adapte IMixinTransformer → ClassFileTransformer.
 *
 * Patch ASM direct (sans ajout de méthodes) :
 *   Nos écrans custom (cf. STUB_PATCHED_SCREENS) — remap stubs Screen/Text
 *   vers les classes obfusquées réelles (ScreenStubPatcher) — voir ce
 *   patcher pour le pourquoi.
 */
public class LauncherMixinTransformerWrapper implements ClassFileTransformer {

    /** Classes compilées contre les stubs Screen/Text — à patcher au chargement. */
    private static final java.util.Set<String> STUB_PATCHED_SCREENS = java.util.Set.of(
        "com/yuyuframe/launcheragent/screen/ResourcePackSearchScreen",
        "com/yuyuframe/launcheragent/screen/ResourcePackDetailScreen",
        "com/yuyuframe/launcheragent/screen/ShaderPackSearchScreen",
        "com/yuyuframe/launcheragent/screen/ShaderPackDetailScreen",
        "com/yuyuframe/launcheragent/screen/CustomKeybindsScreen"
    );

    private final IMixinTransformer transformer;

    public LauncherMixinTransformerWrapper(IMixinTransformer transformer) {
        this.transformer = transformer;
    }

    @Override
    public byte[] transform(ClassLoader loader, String className,
                            Class<?> classBeingRedefined,
                            ProtectionDomain domain,
                            byte[] classfileBuffer) {
        if (classfileBuffer == null || className == null) return null;
        if (isBootstrapPackage(className)) return null;

        // ── Nos propres écrans : remap stubs Screen / Text ───────────────────
        if (STUB_PATCHED_SCREENS.contains(className)) {
            byte[] patched = ScreenStubPatcher.patch(classfileBuffer);
            if (patched != null) return patched;
        }

        String obfDot = className.replace('/', '.');
        String yarnNamed = com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry.INSTANCE.unmap(className);

        return transformer.transformClassBytes(obfDot, yarnNamed.replace('/', '.'), classfileBuffer);
    }

    /**
     * Exclut les classes JDK/bootstrap (java/, javax/, jdk/, sun/, com/sun/)
     * avant de les transmettre à Mixin.
     *
     * Can-Retransform-Classes: true fait que ce transformer est appelé pour
     * TOUTE classe chargée dans la JVM, pas seulement nos cibles Mixin —
     * y compris les classes JDK internes. Si l'une d'elles (ex:
     * java.io.InterruptedIOException, chargée paresseusement à la première
     * E/S interrompue) se charge alors que notre transformer est déjà actif,
     * la transmettre à Mixin peut redéclencher du logging/chargement de
     * classes qui boucle sur cette même classe en cours de définition →
     * ClassCircularityError. Aucune classe JDK n'est jamais une cible Mixin
     * légitime, donc ce filtre est sans risque fonctionnel.
     */
    private static boolean isBootstrapPackage(String className) {
        return className.startsWith("java/")
            || className.startsWith("javax/")
            || className.startsWith("jdk/")
            || className.startsWith("sun/")
            || className.startsWith("com/sun/");
    }
}
