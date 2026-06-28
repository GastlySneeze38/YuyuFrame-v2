package com.yuyuframe.launcheragent.runtime.fabric;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;

/**
 * Enregistre launcher-agent.jar comme "code source" propre à KnotClassLoader
 * (Fabric) — pas juste exposé à son classloader parent.
 *
 * KnotClassDelegate.loadClass() essaie D'ABORD de définir une classe lui-même
 * via ses propres sources connues (mods, libs du jeu). Si la classe demandée
 * n'en fait pas partie (notre cas : launcher-agent.jar, ajouté via
 * -javaagent, jamais déclaré comme mod), Knot délègue ENTIÈREMENT au
 * classloader parent (AppClassLoader). C'est ce qui se passe pour nos écrans
 * custom (ResourcePackSearchScreen) : leur bytecode, après le patch ASM de
 * ScreenStubPatcher (superclasse → net/minecraft/class_437), est défini par
 * AppClassLoader — qui ne peut PAS résoudre "class_437" (un nom intermediary
 * qui n'existe qu'à travers le pipeline de remapping interne de Knot). D'où
 * "NoClassDefFoundError: net/minecraft/class_437" au clic sur le bouton.
 *
 * Fix : KnotClassDelegate#addCodeSource(Path) ajoute notre jar à la liste des
 * sources que Knot gère LUI-MÊME — la classe est alors définie par Knot via
 * son propre pipeline, capable de résoudre les noms intermediary.
 * addCodeSource() vit sur KnotClassDelegate, pas sur KnotClassLoader lui-même
 * (pattern délégué : KnotClassLoader expose getDelegate() pour y accéder).
 * Appelé par réflexion (aucune dépendance de compilation sur les classes
 * internes de Fabric Loader) dès le premier hook Mixin qui s'exécute
 * (TitleScreen), donc largement avant que l'utilisateur ne puisse cliquer sur
 * le bouton.
 */
public final class FabricKnotExposer {

    private FabricKnotExposer() {}

    private static volatile boolean done = false;

    /** @param screenClassLoader classloader réel utilisé par une classe du jeu (ex: this.getClass().getClassLoader() dans un mixin). */
    public static void ensureExposed(ClassLoader screenClassLoader) {
        if (done) return;
        done = true;
        try {
            String jarPath = System.getProperty("launcheragent.jarPath");
            if (jarPath == null || jarPath.isEmpty()) {
                LauncherLog.warn("[LauncherAgent] FabricKnotExposer: launcheragent.jarPath non défini");
                return;
            }
            java.nio.file.Path path = java.nio.file.Paths.get(jarPath);

            // addCodeSource() peut être non-publique et/ou vivre sur un champ
            // délégué (ex: KnotClassDelegate) plutôt que sur le classloader
            // lui-même — recherche élargie : méthodes déclarées (pas seulement
            // publiques) sur le classloader ET sur tout objet trouvé dans ses
            // champs déclarés (toute la hiérarchie de classes).
            if (invokeAddCodeSourceDeep(screenClassLoader, path, new java.util.HashSet<>())) return;

            LauncherLog.warn("[LauncherAgent] FabricKnotExposer: addCodeSource(Path) introuvable sur "
                + screenClassLoader.getClass().getName() + " — dump diagnostique :");
            dumpClassMembers(screenClassLoader.getClass());
        } catch (Throwable t) {
            LauncherLog.warn("[LauncherAgent] FabricKnotExposer: " + t);
        }
    }

    /** Cherche addCodeSource(Path) sur {@code target} (méthodes déclarées, toute la hiérarchie), puis sur chacun de ses champs objets (récursif, anti-boucle via {@code visited}). */
    private static boolean invokeAddCodeSourceDeep(Object target, java.nio.file.Path path, java.util.Set<Object> visited) {
        if (target == null || !visited.add(target)) return false;

        java.lang.reflect.Method addCodeSource = findDeclaredMethod(target.getClass(), "addCodeSource", java.nio.file.Path.class);
        if (addCodeSource != null) {
            try {
                addCodeSource.setAccessible(true);
                addCodeSource.invoke(target, path);
                LauncherLog.ui(3, "[LauncherAgent] FabricKnotExposer: " + path + " ajouté comme code source Knot (via "
                    + target.getClass().getName() + ")");
                return true;
            } catch (Exception e) {
                LauncherLog.warn("[LauncherAgent] FabricKnotExposer: addCodeSource a échoué sur "
                    + target.getClass().getName() + ": " + e);
            }
        }

        Class<?> c = target.getClass();
        while (c != null && !c.getName().equals("java.lang.Object")) {
            for (java.lang.reflect.Field f : c.getDeclaredFields()) {
                if (f.getType().isPrimitive() || f.getType().isArray()) continue;
                String pkg = f.getType().getName();
                if (!pkg.startsWith("net.fabricmc.") && !pkg.startsWith("com.yuyuframe.")) continue;
                try {
                    f.setAccessible(true);
                    Object value = f.get(target);
                    if (invokeAddCodeSourceDeep(value, path, visited)) return true;
                } catch (Exception ignored) {}
            }
            c = c.getSuperclass();
        }
        return false;
    }

    private static java.lang.reflect.Method findDeclaredMethod(Class<?> start, String name, Class<?> paramType) {
        Class<?> c = start;
        while (c != null) {
            for (java.lang.reflect.Method m : c.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterCount() == 1 && m.getParameterTypes()[0] == paramType) {
                    return m;
                }
            }
            c = c.getSuperclass();
        }
        return null;
    }

    private static void dumpClassMembers(Class<?> cls) {
        Class<?> c = cls;
        while (c != null && !c.getName().equals("java.lang.Object")) {
            StringBuilder fields = new StringBuilder();
            for (java.lang.reflect.Field f : c.getDeclaredFields()) fields.append(f.getType().getSimpleName()).append(' ').append(f.getName()).append(", ");
            StringBuilder methods = new StringBuilder();
            for (java.lang.reflect.Method m : c.getDeclaredMethods()) methods.append(m.getName()).append('(').append(m.getParameterCount()).append("), ");
            LauncherLog.warn("[LauncherAgent] FabricKnotExposer:   " + c.getName() + " champs=[" + fields + "] méthodes=[" + methods + "]");
            c = c.getSuperclass();
        }
    }
}
