package com.yuyuframe.launcheragent.mixin.service.transformer;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry;
import org.objectweb.asm.*;

/**
 * Transforme ResourcePackSearchScreen pour remplacer les stubs de compilation
 * par les classes réelles obfusquées résolues via Yarn.
 *
 * Copie indépendante de com.p2pminecraft.mixin.service.transformer.ScreenStubPatcher
 * (p2p-agent) — même bug, même fix : nos écrans custom compilent contre des
 * stubs (net.minecraft.client.gui.screens.Screen / net.minecraft.network.chat.Component)
 * qui n'ont AUCUNE relation de type avec les vraies classes obfusquées du jeu
 * (gsb, yh...). Sans ce patch, l'écran ne serait jamais assignable au
 * paramètre de MinecraftClient.setScreen(Screen) → "setScreen introuvable" en
 * silence (ScreenHelper.navigate() ne trouve aucune méthode compatible).
 *
 * Stubs visés (noms Yarn, namespace "named") :
 *   net/minecraft/client/gui/screen/Screen  → obfusqué (ex: gsb)
 *   net/minecraft/text/Text                 → obfusqué (ex: yh)
 */
public final class ScreenStubPatcher {

    private ScreenStubPatcher() {}

    /**
     * Méthodes déclarées dans nos écrans custom dont le nom "official" doit
     * être traduit vers le nom runtime AVANT que le JVM ne les lie comme
     * override — voir le commentaire sur visitMethod() ci-dessous. Chaque
     * entrée : (nom+descripteur écrits dans le code source) → (classe
     * officielle propriétaire, nom officiel, descripteur officiel) tel
     * qu'attendu par MappingsRegistry.runtimeMethod().
     */
    private static final class OverrideMethods {
        private record Key(String name, String desc) {}
        private record Owner(String officialClass, String officialName, String officialDesc) {}
        private final java.util.Map<Key, Owner> table = new java.util.HashMap<>();

        void register(String declaredName, String declaredDesc, String officialClass, String officialName, String officialDesc) {
            table.put(new Key(declaredName, declaredDesc), new Owner(officialClass, officialName, officialDesc));
        }

        String translate(String declaredName, String declaredDesc) {
            Owner o = table.get(new Key(declaredName, declaredDesc));
            if (o == null) return declaredName;
            return MappingsRegistry.runtimeMethod(o.officialClass(), o.officialName(), o.officialDesc());
        }
    }

    private static final OverrideMethods OVERRIDE_METHODS = new OverrideMethods();
    static {
        // Screen.init() — voir docs/LauncherAgent/index.md, refmap TitleScreen/PackScreen.
        OVERRIDE_METHODS.register("bg_", "()V", "gsb", "bg_", "()V");
        // Element.mouseScrolled(double,double,double,double) — voir mappings.tiny classe "gmm".
        OVERRIDE_METHODS.register("a", "(DDDD)Z", "gmm", "a", "(DDDD)Z");
        // Screen.tick() — utilisé par CustomKeybindsScreen pour scruter l'état GLFW
        // des touches (mode "écoute" de rebind) sans toucher à keyPressed (qui prend
        // désormais un type record "KeyInput" sans stub compilable, comme "Click"
        // pour la souris — voir docs/LauncherAgent/index.md).
        OVERRIDE_METHODS.register("tick", "()V", "gsb", "e", "()V");
        // Screen.shouldCloseOnEsc() — renvoyé à `false` pendant l'écoute d'une
        // touche pour qu'Échap annule l'écoute SANS fermer tout l'écran.
        OVERRIDE_METHODS.register("shouldCloseOnEsc", "()Z", "gsb", "aY_", "()Z");
    }

    public static byte[] patch(byte[] classBytes) {
        try {
            final String STUB_SCREEN     = "net/minecraft/client/gui/screen/Screen";
            final String STUB_SCREEN_ALT = "net/minecraft/client/gui/screens/Screen";
            final String STUB_COMP       = "net/minecraft/text/Text";
            final String STUB_COMP_ALT   = "net/minecraft/network/chat/Component";

            ClassReader cr = new ClassReader(classBytes);
            String realScreen = MappingsRegistry.INSTANCE.map(STUB_SCREEN);
            String realComp   = MappingsRegistry.INSTANCE.map(STUB_COMP);

            if (STUB_SCREEN.equals(realScreen)) {
                LauncherLog.asm(1, "[LauncherAgent ASM] " + cr.getClassName() + ": Screen non mappé (mode non-obfusqué), skip");
                return null;
            }
            LauncherLog.asm(1, "[LauncherAgent ASM] " + cr.getClassName() + ": Screen=" + realScreen
                    + "  Text=" + realComp);
            ClassWriter cw = new ClassWriter(ClassWriter.COMPUTE_MAXS) {
                @Override protected String getCommonSuperClass(String t1, String t2) {
                    return "java/lang/Object";
                }
            };

            cr.accept(new ClassVisitor(Opcodes.ASM9, cw) {
                private boolean isStubScreen(String s) {
                    return STUB_SCREEN.equals(s) || STUB_SCREEN_ALT.equals(s);
                }
                private boolean isStubComp(String s) {
                    return STUB_COMP.equals(s) || STUB_COMP_ALT.equals(s);
                }
                private String remapAll(String desc) {
                    return desc.replace("L" + STUB_SCREEN + ";",     "L" + realScreen + ";")
                               .replace("L" + STUB_SCREEN_ALT + ";", "L" + realScreen + ";")
                               .replace("L" + STUB_COMP + ";",       "L" + realComp + ";")
                               .replace("L" + STUB_COMP_ALT + ";",   "L" + realComp + ";");
                }

                @Override
                public void visit(int version, int access, String name, String signature,
                                  String superName, String[] interfaces) {
                    String newSuper = isStubScreen(superName) ? realScreen : superName;
                    super.visit(version, access, name, signature, newSuper, interfaces);
                }

                @Override
                public FieldVisitor visitField(int access, String name, String descriptor,
                                               String signature, Object value) {
                    return super.visitField(access, name, remapAll(descriptor), signature, value);
                }

                @Override
                public MethodVisitor visitMethod(int access, String name, String descriptor,
                                                 String signature, String[] exceptions) {
                    // Renomme la méthode déclarée ELLE-MÊME quand son nom+descripteur
                    // "official" (ex: "bg_()V" pour Screen.init(), "a(DDDD)Z" pour
                    // Element.mouseScrolled) correspond à un override polymorphique
                    // réel attendu par le jeu — sous Fabric, le vrai nom à l'exécution
                    // est "intermediary" (ex: method_25426), donc "bg_()V" tel
                    // qu'écrit dans le code source n'est PAS un override du tout :
                    // le JVM ne le considère lié à aucune méthode de la vraie
                    // superclasse, donc Screen.init() ne fait jamais rien et l'écran
                    // reste vide. remapAll() (descripteurs des appels/champs internes)
                    // ne couvre pas ce cas car ici c'est la DÉCLARATION elle-même qui
                    // doit changer de nom, pas une référence.
                    String runtimeName = OVERRIDE_METHODS.translate(name, descriptor);
                    MethodVisitor mv = super.visitMethod(access, runtimeName, remapAll(descriptor), signature, exceptions);
                    return new MethodVisitor(Opcodes.ASM9, mv) {
                        @Override
                        public void visitMethodInsn(int opcode, String owner, String mName,
                                                    String mDesc, boolean isInterface) {
                            if (isStubScreen(owner)) owner = realScreen;
                            else if (isStubComp(owner)) {
                                owner = realComp;
                                mName = MappingsRegistry.getObfMethodName(STUB_COMP, mName);
                            }
                            super.visitMethodInsn(opcode, owner, mName, remapAll(mDesc), isInterface);
                        }

                        @Override
                        public void visitTypeInsn(int opcode, String type) {
                            if (isStubScreen(type)) type = realScreen;
                            else if (isStubComp(type)) type = realComp;
                            super.visitTypeInsn(opcode, type);
                        }

                        @Override
                        public void visitFieldInsn(int opcode, String owner,
                                                   String fName, String fDesc) {
                            if (isStubScreen(owner)) owner = realScreen;
                            else if (isStubComp(owner)) owner = realComp;
                            super.visitFieldInsn(opcode, owner, fName, remapAll(fDesc));
                        }
                    };
                }
            }, ClassReader.EXPAND_FRAMES);

            LauncherLog.asm(3, "[LauncherAgent ASM] " + cr.getClassName() + " patché : superclasse → " + realScreen);
            return cw.toByteArray();
        } catch (Exception e) {
            LauncherLog.err("[LauncherAgent ASM] Erreur patch écran custom: " + e);
            e.printStackTrace(System.err);
            return null;
        }
    }
}
