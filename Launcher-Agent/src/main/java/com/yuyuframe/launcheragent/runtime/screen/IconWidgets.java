package com.yuyuframe.launcheragent.runtime.screen;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Affiche des icônes de resource pack téléchargées (PNG Modrinth) via le vrai
 * widget vanilla {@code IconWidget} — pas de surcharge du rendu de l'écran.
 *
 * Vanilla affiche déjà des icônes de pack dans l'écran Resource Packs lui-même
 * (PackScreen) via un widget autonome, pas un appel de dessin manuel dans une
 * méthode render() qu'on aurait dû identifier/surcharger à l'aveugle (ce
 * risque avait justifié de ne pas implémenter les images dans une itération
 * précédente — voir docs/LauncherAgent/index.md). En retrouvant ce widget
 * dans les mappings (`net.minecraft.client.gui.widget.IconWidget`/`.Texture`),
 * on peut juste l'ajouter comme n'importe quel autre widget (ScreenHelper.addWidget,
 * déjà utilisé pour les boutons/EditBox/TextWidget) : le risque disparaît.
 *
 * Pipeline (toutes les classes/méthodes confirmées dans mappings/mappings.tiny) :
 *   bytes PNG → NativeImage.read([B)  (classe "fyh")
 *             → NativeImageBackedTexture(Supplier, NativeImage)  (classe "ilc")
 *             → TextureManager.registerTexture(Identifier, AbstractTexture)  (classe "ilr")
 *             → IconWidget.create(width, height, Identifier, texW, texH)  (classe "gjr")
 *
 * Comme ScreenHelper, tous les littéraux sont "official" et passent par
 * MappingsRegistry.runtime*() — sous Fabric (intermediary), ça renvoie
 * l'équivalent réel ; en vanilla, le littéral inchangé.
 */
public final class IconWidgets {

    private IconWidgets() {}

    private static final String CLS_NATIVE_IMAGE   = "fyh";
    private static final String CLS_BACKED_TEXTURE  = "ilc";
    private static final String CLS_IDENTIFIER      = "amo";
    private static final String CLS_TEXTURE_MANAGER = "ilr";
    private static final String CLS_ICON_WIDGET     = "gjr";

    /** identifier, texWidth, texHeight — mis en cache pour ne décoder/enregistrer qu'une fois par fichier. */
    private static final Map<String, Object[]> CACHE = new ConcurrentHashMap<>();

    public static Path cacheDir() {
        String appData = System.getenv("APPDATA");
        Path dir = appData != null
            ? Paths.get(appData, "YuyuFrame", "agent", "icon-cache")
            : Paths.get("icon-cache");
        try { Files.createDirectories(dir); } catch (IOException ignored) {}
        return dir;
    }

    public static Path cacheFile(String projectId) {
        return cacheDir().resolve(sanitize(projectId) + ".png");
    }

    private static String sanitize(String s) {
        return (s == null || s.isEmpty()) ? "x" : s.replaceAll("[^a-zA-Z0-9_-]", "_");
    }

    /**
     * Décode + enregistre la texture si pas déjà fait pour ce {@code cacheKey}
     * (mis en cache, donc sans coût les appels suivants), et renvoie son
     * Identifier — réutilisable avec {@link #setTexture} sur un IconWidget
     * déjà créé, plutôt que d'en recréer un (pas de removeWidget fiable).
     * Retourne {@code null} si le fichier est absent/invalide.
     */
    public static Object getOrRegisterIdentifier(Object screen, String cacheKey, Path pngFile, int boxSize) {
        Object[] entry = CACHE.computeIfAbsent(cacheKey + "@" + boxSize, k -> registerTexture(screen, cacheKey, pngFile, boxSize));
        return entry == null ? null : entry[0];
    }

    /**
     * Construit un nouveau widget IconWidget de taille {@code boxSize}²
     * positionné à (x,y) pour ce {@code cacheKey}. À n'appeler qu'une fois par
     * slot réutilisable (cf. ResourcePackSearchScreen.attachIcon) — pour
     * changer l'icône d'un widget déjà créé, utiliser {@link #setTexture}.
     */
    public static Object loadIconWidget(Object screen, String cacheKey, Path pngFile, int x, int y, int boxSize) {
        try {
            Object[] entry = CACHE.computeIfAbsent(cacheKey + "@" + boxSize, k -> registerTexture(screen, cacheKey, pngFile, boxSize));
            if (entry == null) return null;
            Object identifier = entry[0];
            int texW = (Integer) entry[1];
            int texH = (Integer) entry[2];

            ClassLoader cl = screen.getClass().getClassLoader();
            Class<?> iconWidgetClass = Class.forName(MappingsRegistry.runtimeClass(CLS_ICON_WIDGET), true, cl);
            Set<String> createNames = MappingsRegistry.runtimeMethodNames(CLS_ICON_WIDGET, "a");
            for (java.lang.reflect.Method m : iconWidgetClass.getDeclaredMethods()) {
                if (!createNames.contains(m.getName()) || m.getParameterCount() != 5) continue;
                Class<?>[] pt = m.getParameterTypes();
                if (pt[0] != int.class || pt[1] != int.class || pt[3] != int.class || pt[4] != int.class) continue;
                if (!java.lang.reflect.Modifier.isStatic(m.getModifiers())) continue;
                m.setAccessible(true);
                Object widget = m.invoke(null, boxSize, boxSize, identifier, texW, texH);
                ScreenHelper.setPosition(widget, x, y);
                return widget;
            }
            LauncherLog.warn("[LauncherAgent-Screen] IconWidget.create introuvable");
        } catch (Throwable t) {
            LauncherLog.warn("[LauncherAgent-Screen] loadIconWidget: " + t);
        }
        return null;
    }

    /** Change la texture d'un IconWidget déjà créé (réutilise le widget plutôt que d'en créer un nouveau). */
    public static void setTexture(Object iconWidget, Object identifier) {
        if (iconWidget == null || identifier == null) return;
        try {
            Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_ICON_WIDGET, "a");
            for (java.lang.reflect.Method m : iconWidget.getClass().getMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 1
                        && !m.getParameterTypes()[0].isPrimitive()
                        && m.getParameterTypes()[0].isInstance(identifier)) {
                    m.setAccessible(true);
                    m.invoke(iconWidget, identifier);
                    return;
                }
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] IconWidgets.setTexture: " + e
                + (e.getCause() != null ? " cause=" + e.getCause() : ""));
        }
    }

    private static Object[] registerTexture(Object screen, String cacheKey, Path pngFile, int boxSize) {
        try {
            if (!Files.isRegularFile(pngFile)) return null;
            byte[] raw = Files.readAllBytes(pngFile);
            // Modrinth ne garantit ni le format (PNG/JPEG/WebP — NativeImage.read()
            // ne décode que du PNG, d'où "Bad PNG Signature" observé sur certains
            // icon_url) ni une résolution correspondant à la boîte d'affichage
            // (typiquement 20-32px alors que les icônes sources font souvent
            // 256-512px). IconWidget.create(width,height,texture,textureWidth,
            // textureHeight) attend que textureWidth/textureHeight reflètent la
            // résolution RÉELLEMENT uploadée — sinon le rendu n'affiche qu'une
            // fenêtre UV de la taille de la boîte dans le coin de la texture
            // réelle (un minuscule recadrage, pas une image réduite). Décoder
            // via ImageIO (gère PNG/JPEG/GIF/BMP nativement) puis redimensionner
            // RÉELLEMENT les pixels à boxSize×boxSize avant de ré-encoder en PNG
            // règle les deux problèmes d'un coup : le format en entrée n'a plus
            // d'importance, et résolution réelle == déclarée == boîte d'affichage.
            byte[] bytes = normalizeToPng(raw, boxSize);
            if (bytes == null) {
                LauncherLog.warn("[LauncherAgent-Screen] registerTexture(" + cacheKey + "): image illisible (ImageIO)");
                return null;
            }
            ClassLoader cl = screen.getClass().getClassLoader();

            // NativeImage.read(byte[])
            Class<?> nativeImageClass = Class.forName(MappingsRegistry.runtimeClass(CLS_NATIVE_IMAGE), true, cl);
            Set<String> readNames = MappingsRegistry.runtimeMethodNames(CLS_NATIVE_IMAGE, "a");
            Object nativeImage = null;
            for (java.lang.reflect.Method m : nativeImageClass.getDeclaredMethods()) {
                if (readNames.contains(m.getName()) && m.getParameterCount() == 1
                        && m.getParameterTypes()[0] == byte[].class
                        && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    m.setAccessible(true);
                    nativeImage = m.invoke(null, bytes);
                    break;
                }
            }
            if (nativeImage == null) { LauncherLog.warn("[LauncherAgent-Screen] NativeImage.read introuvable"); return null; }

            int texW = (int) invokeNoArg(nativeImage, MappingsRegistry.runtimeMethodNames(CLS_NATIVE_IMAGE, "a"), int.class);
            int texH = (int) invokeNoArg(nativeImage, MappingsRegistry.runtimeMethodNames(CLS_NATIVE_IMAGE, "b"), int.class);

            // new NativeImageBackedTexture(Supplier<String>, NativeImage)
            Class<?> texClass = Class.forName(MappingsRegistry.runtimeClass(CLS_BACKED_TEXTURE), true, cl);
            Object texture = null;
            java.util.function.Supplier<String> nameSupplier = () -> "launcheragent/" + cacheKey;
            for (java.lang.reflect.Constructor<?> c : texClass.getDeclaredConstructors()) {
                Class<?>[] pt = c.getParameterTypes();
                if (pt.length == 2 && pt[0] == java.util.function.Supplier.class && pt[1] == nativeImageClass) {
                    c.setAccessible(true);
                    texture = c.newInstance(nameSupplier, nativeImage);
                    break;
                }
            }
            if (texture == null) { LauncherLog.warn("[LauncherAgent-Screen] NativeImageBackedTexture ctor introuvable"); return null; }

            // Identifier.of(namespace, path)
            Class<?> idClass = Class.forName(MappingsRegistry.runtimeClass(CLS_IDENTIFIER), true, cl);
            Set<String> ofNames = MappingsRegistry.runtimeMethodNames(CLS_IDENTIFIER, "a");
            Object identifier = null;
            for (java.lang.reflect.Method m : idClass.getDeclaredMethods()) {
                if (ofNames.contains(m.getName()) && m.getParameterCount() == 2
                        && m.getParameterTypes()[0] == String.class && m.getParameterTypes()[1] == String.class
                        && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    m.setAccessible(true);
                    identifier = m.invoke(null, "launcheragent", "icon/" + cacheKey.toLowerCase());
                    break;
                }
            }
            if (identifier == null) { LauncherLog.warn("[LauncherAgent-Screen] Identifier.of introuvable"); return null; }

            // textureManager.registerTexture(identifier, texture)
            String textureManagerClassName = MappingsRegistry.runtimeClass(CLS_TEXTURE_MANAGER);
            Object mc = ScreenHelper.getMc(screen);
            Object textureManager = null;
            for (java.lang.reflect.Method m : mc.getClass().getMethods()) {
                if (m.getParameterCount() == 0 && m.getReturnType().getName().equals(textureManagerClassName)) {
                    m.setAccessible(true);
                    textureManager = m.invoke(mc);
                    break;
                }
            }
            if (textureManager == null) { LauncherLog.warn("[LauncherAgent-Screen] getTextureManager introuvable"); return null; }

            Set<String> registerNames = MappingsRegistry.runtimeMethodNames(CLS_TEXTURE_MANAGER, "a");
            for (java.lang.reflect.Method m : textureManager.getClass().getMethods()) {
                if (registerNames.contains(m.getName()) && m.getParameterCount() == 2
                        && m.getParameterTypes()[0].isInstance(identifier)
                        && m.getParameterTypes()[1].isInstance(texture)) {
                    m.setAccessible(true);
                    m.invoke(textureManager, identifier, texture);
                    return new Object[]{identifier, texW, texH};
                }
            }
            LauncherLog.warn("[LauncherAgent-Screen] TextureManager.registerTexture introuvable");
            return null;
        } catch (Throwable t) {
            LauncherLog.warn("[LauncherAgent-Screen] registerTexture(" + cacheKey + "): " + t
                + (t.getCause() != null ? " cause=" + t.getCause() : ""));
            if (t.getCause() != null) t.getCause().printStackTrace(System.err);
            return null;
        }
    }

    /** Décode (ImageIO, tout format supporté), redimensionne à boxSize×boxSize, ré-encode en PNG. Null si illisible. */
    private static byte[] normalizeToPng(byte[] raw, int boxSize) {
        try {
            java.awt.image.BufferedImage src;
            try (java.io.ByteArrayInputStream in = new java.io.ByteArrayInputStream(raw)) {
                src = javax.imageio.ImageIO.read(in);
            }
            if (src == null) return null;

            java.awt.image.BufferedImage resized =
                new java.awt.image.BufferedImage(boxSize, boxSize, java.awt.image.BufferedImage.TYPE_INT_ARGB);
            java.awt.Graphics2D g = resized.createGraphics();
            try {
                g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION,
                    java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                g.setRenderingHint(java.awt.RenderingHints.KEY_RENDERING,
                    java.awt.RenderingHints.VALUE_RENDER_QUALITY);
                g.drawImage(src, 0, 0, boxSize, boxSize, null);
            } finally {
                g.dispose();
            }

            try (java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
                if (!javax.imageio.ImageIO.write(resized, "png", out)) return null;
                return out.toByteArray();
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] normalizeToPng: " + e);
            return null;
        }
    }

    private static Object invokeNoArg(Object target, Set<String> names, Class<?> returnType) throws Exception {
        for (java.lang.reflect.Method m : target.getClass().getMethods()) {
            if (names.contains(m.getName()) && m.getParameterCount() == 0 && m.getReturnType() == returnType) {
                m.setAccessible(true);
                return m.invoke(target);
            }
        }
        throw new NoSuchMethodException(names + "()" + returnType);
    }
}
