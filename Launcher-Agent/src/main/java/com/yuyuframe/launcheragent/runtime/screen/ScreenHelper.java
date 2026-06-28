package com.yuyuframe.launcheragent.runtime.screen;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry;

/**
 * Utilitaires réflexion partagés pour ajouter des widgets et naviguer entre écrans.
 * Toutes les méthodes Minecraft sont obfusquées — on passe par getDeclaredMethods/Fields.
 *
 * Copie indépendante de com.p2pminecraft.screen.ScreenHelper (p2p-agent) — même
 * pattern de reflection, mêmes noms obfusqués (même version MC, mêmes mappings
 * Yarn), mais aucune dépendance de code entre les deux agents. Les helpers
 * spécifiques au bouton TitleScreen du p2p-agent (pushWidgetsDown, etc.) ne
 * sont pas repris ici — LauncherAgent ajoute ses widgets sur des écrans neufs
 * ou en zone libre, pas en décalant la mise en page vanilla.
 *
 * Tous les littéraux de classe/champ/méthode ci-dessous sont écrits en "official"
 * (obfuscation brute Mojang) et passés par MappingsRegistry.runtime*() avant
 * tout usage — sous Fabric (MappingsRegistry.Scheme.INTERMEDIARY), ça renvoie
 * l'équivalent "intermediary" réellement présent à l'exécution ; en vanilla,
 * ça renvoie le littéral inchangé. Voir docs/LauncherAgent/index.md.
 */
public class ScreenHelper {

    // Classes officielles propriétaires des membres traduits ci-dessous —
    // centralisées ici pour ne pas répéter la chaîne à chaque appel.
    private static final String CLS_SCREEN          = "gsb"; // net.minecraft.client.gui.screen.Screen
    private static final String CLS_CLICKABLE       = "gjc"; // net.minecraft.client.gui.widget.ClickableWidget
    private static final String CLS_BUTTON          = "gje"; // net.minecraft.client.gui.widget.Button
    private static final String CLS_BUTTON_ONPRESS  = "gje$c";
    private static final String CLS_BUTTON_BUILDER  = "gje$a"; // net.minecraft.client.gui.widget.ButtonWidget$Builder
    private static final String CLS_EDIT_BOX        = "gjn"; // net.minecraft.client.gui.widget.TextFieldWidget
    private static final String CLS_TEXT             = "yh"; // net.minecraft.text.Text
    private static final String CLS_MINECRAFT_CLIENT = "gfj"; // net.minecraft.client.MinecraftClient

    // ── Component.literal ─────────────────────────────────────────────────────

    public static Object literal(ClassLoader cl, String text) {
        try {
            String runtimeClassName = MappingsRegistry.runtimeClass(CLS_TEXT);
            java.util.Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_TEXT, "b");
            LauncherLog.ui(1, "[LauncherAgent-Screen] literal: classe=" + runtimeClassName + " noms cherchés=" + names);
            Class<?> compClass = Class.forName(runtimeClassName, true, cl);
            for (java.lang.reflect.Method m : compClass.getDeclaredMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 1
                        && m.getParameterTypes()[0] == String.class
                        && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    return m.invoke(null, text);
                }
            }
            StringBuilder all = new StringBuilder();
            for (java.lang.reflect.Method m : compClass.getDeclaredMethods()) {
                if (m.getParameterCount() == 1 && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    all.append(m.getName()).append('(').append(m.getParameterTypes()[0].getSimpleName()).append(") ");
                }
            }
            LauncherLog.ui(1, "[LauncherAgent-Screen] literal: AUCUNE methode statique 1-arg ne correspond. Candidates 1-arg statiques sur " + runtimeClassName + ": " + all);
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] literal: " + e); }
        return null;
    }

    /** Variante sans ClassLoader explicite — utilisable depuis un constructeur (avant super()). */
    public static Object literal(String text) {
        return literal(Thread.currentThread().getContextClassLoader(), text);
    }

    /**
     * Extrait une chaîne brute (best-effort, pour filtrage de recherche
     * uniquement — pas pour l'affichage) d'un objet Text : aucune entrée
     * "official" fiable trouvée dans les mappings pour Text.getString()
     * (probablement un défaut d'interface dont Yarn ne documente pas le nom
     * official séparément) — recherche défensive de la première méthode
     * publique 0-arg renvoyant String.
     */
    public static String textToPlainString(Object text) {
        if (text == null) return "";
        try {
            for (java.lang.reflect.Method m : text.getClass().getMethods()) {
                if (m.getParameterCount() == 0 && m.getReturnType() == String.class) {
                    Object r = m.invoke(text);
                    if (r != null) return (String) r;
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] textToPlainString: " + e); }
        return "";
    }

    /** Text.translatable(String) ("c" sur yh, (Ljava/lang/String;)Lyw;) — pour les clés de lang.json (ex: "key.jump"). */
    public static Object translatable(ClassLoader cl, String key) {
        try {
            String runtimeClassName = MappingsRegistry.runtimeClass(CLS_TEXT);
            java.util.Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_TEXT, "c");
            Class<?> compClass = Class.forName(runtimeClassName, true, cl);
            for (java.lang.reflect.Method m : compClass.getDeclaredMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 1
                        && m.getParameterTypes()[0] == String.class
                        && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    return m.invoke(null, key);
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] translatable: " + e); }
        return null;
    }

    // ── Titre de l'écran ──────────────────────────────────────────────────────

    /**
     * Ajoute un widget-titre centré en haut (y donné).
     * Essaie StringWidget (rendu texte pur) puis fallback bouton désactivé.
     */
    public static void addTitleLabel(Object screen, String text, int y) {
        try {
            ClassLoader cl = screen.getClass().getClassLoader();
            Object comp = literal(cl, text);
            Object font = getField(screen, CLS_SCREEN, "q");
            if (comp == null || font == null) { addTitleFallback(screen, text, y); return; }
            int w = getWidth(screen);

            int textWidth = measureTextWidth(font, comp);
            int tx = w / 2 - textWidth / 2;

            // Nom Yarn (named) — pas un littéral "official" à traduire, donc pas
            // de MappingsRegistry.runtimeClass ici : Class.forName échoue
            // systématiquement avec ce nom (déjà le cas avant le support Fabric),
            // ce qui retombe sur addTitleFallback ci-dessous dans tous les cas.
            String swObf = "net/minecraft/client/gui/widget/TextWidget".replace('/', '.');
            try {
                Class<?> swClass = Class.forName(swObf, true, cl);
                for (java.lang.reflect.Constructor<?> ctor : swClass.getDeclaredConstructors()) {
                    Class<?>[] pt = ctor.getParameterTypes();
                    if (pt.length == 6 && pt[0] == int.class && pt[1] == int.class
                            && pt[2] == int.class && pt[3] == int.class
                            && !pt[4].isPrimitive() && !pt[5].isPrimitive()) {
                        ctor.setAccessible(true);
                        Object widget = ctor.newInstance(tx, y, textWidth + 4, 20, comp, font);
                        addWidget(screen, widget);
                        return;
                    }
                }
            } catch (ClassNotFoundException ignored) {}

            addTitleFallback(screen, text, y);
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] addTitleLabel: " + e);
            addTitleFallback(screen, text, y);
        }
    }

    /** Largeur en pixels de {@code text} (codes couleur §x ignorés) avec la police de l'écran. */
    public static int textWidth(Object screen, String text) {
        try {
            ClassLoader cl = screen.getClass().getClassLoader();
            Object comp = literal(cl, text);
            Object font = getField(screen, CLS_SCREEN, "q");
            if (comp == null || font == null) return text.length() * 6;
            return measureTextWidth(font, comp);
        } catch (Exception e) {
            return text.length() * 6;
        }
    }

    private static int measureTextWidth(Object font, Object comp) {
        try {
            for (java.lang.reflect.Method m : font.getClass().getMethods()) {
                if (m.getParameterCount() != 1 || m.getReturnType() != int.class) continue;
                Class<?> pt = m.getParameterTypes()[0];
                if (!pt.isPrimitive() && pt.isInstance(comp)) {
                    try { return (int) m.invoke(font, comp); }
                    catch (Exception ignored) {}
                }
            }
        } catch (Exception ignored) {}
        return 120;
    }

    private static void addTitleFallback(Object screen, String text, int y) {
        int w = getWidth(screen);
        Object btn = addButton(screen, 10, y, w - 20, 14, text, () -> {});
        setActive(btn, false);
    }

    // ── addRenderableWidget ───────────────────────────────────────────────────

    public static Object addWidget(Object screen, Object widget) {
        if (widget == null) return null;
        try {
            java.util.Set<String> addNames = MappingsRegistry.runtimeMethodNames(CLS_SCREEN, "c");
            LauncherLog.ui(1, "[LauncherAgent-Screen] addWidget: addNames=" + addNames + " widgetClass=" + widget.getClass().getName());
            for (java.lang.reflect.Method m : screen.getClass().getMethods()) {
                if (addNames.contains(m.getName()) && m.getParameterCount() == 1) {
                    LauncherLog.ui(1, "[LauncherAgent-Screen] addWidget: candidat 1-arg " + m + " isInstance=" + m.getParameterTypes()[0].isInstance(widget));
                    if (m.getParameterTypes()[0].isInstance(widget)) {
                        return m.invoke(screen, widget);
                    }
                }
            }
            for (java.lang.reflect.Method m : screen.getClass().getMethods()) {
                if (addNames.contains(m.getName()) && m.getParameterCount() == 1
                        && !m.getParameterTypes()[0].isPrimitive()) {
                    try { return m.invoke(screen, widget); }
                    catch (IllegalArgumentException ignored) {}
                }
            }
            // IMPORTANT : ces boucles de repli (getDeclaredMethods(), pour
            // attraper addDrawableChild quand il est protected donc absent de
            // getMethods()) DOIVENT filtrer par addNames comme les boucles
            // ci-dessus — sans ce filtre, n'importe quelle méthode déclarée sur
            // Screen à 1 paramètre dont le type est satisfait par le widget
            // (ex: method_65517(Lgpb;)Stream — Selectable, que Button implémente
            // aussi) peut matcher avant la vraie addDrawableChild, puisque
            // getDeclaredMethods() ne garantit aucun ordre stable entre deux
            // lancements JVM (bug observé : un build sur deux renvoyait un
            // Stream au lieu du Button ajouté).
            Class<?> sc = screen.getClass().getSuperclass();
            while (sc != null && !sc.getName().equals("java.lang.Object")) {
                for (java.lang.reflect.Method m : sc.getDeclaredMethods()) {
                    if (!addNames.contains(m.getName())) continue;
                    if (m.getParameterCount() != 1 || m.getParameterTypes()[0].isPrimitive()) continue;
                    if (m.getReturnType() == Void.TYPE) continue;
                    if (!m.getParameterTypes()[0].isInstance(widget)) continue;
                    try {
                        m.setAccessible(true);
                        Object r = m.invoke(screen, widget);
                        return r != null ? r : widget;
                    } catch (Exception ignored) {}
                }
                sc = sc.getSuperclass();
            }
            sc = screen.getClass().getSuperclass();
            while (sc != null && !sc.getName().equals("java.lang.Object")) {
                for (java.lang.reflect.Method m : sc.getDeclaredMethods()) {
                    if (!addNames.contains(m.getName())) continue;
                    if (m.getParameterCount() != 1 || m.getParameterTypes()[0].isPrimitive()) continue;
                    if (m.getReturnType() != Void.TYPE) continue;
                    if (!m.getParameterTypes()[0].isInstance(widget)) continue;
                    try {
                        m.setAccessible(true);
                        m.invoke(screen, widget);
                        return widget;
                    } catch (Exception ignored) {}
                }
                sc = sc.getSuperclass();
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] addWidget: " + e); }
        return null;
    }

    // ── Button.builder ────────────────────────────────────────────────────────

    public static Object addButton(Object screen, int x, int y, int w, int h, String label, Runnable action) {
        try {
            ClassLoader cl = screen.getClass().getClassLoader();
            Object comp = literal(cl, label);
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: literal(\"" + label + "\") = " + comp);
            if (comp == null) return null;

            String onPressClassName = MappingsRegistry.runtimeClass(CLS_BUTTON_ONPRESS);
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: onPressClass=" + onPressClassName);
            Class<?> onPressClass = Class.forName(onPressClassName, true, cl);
            Object onPress = java.lang.reflect.Proxy.newProxyInstance(
                cl, new Class[]{ onPressClass },
                (proxy, method, args) -> { if ("onPress".equals(method.getName())) action.run(); return null; }
            );

            String btnClassName = MappingsRegistry.runtimeClass(CLS_BUTTON);
            Class<?> btnClass = Class.forName(btnClassName, true, cl);
            java.util.Set<String> builderNames = MappingsRegistry.runtimeMethodNames(CLS_BUTTON, "a");
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: btnClass=" + btnClassName + " builderNames=" + builderNames);
            java.lang.reflect.Method builderMethod = null;
            for (java.lang.reflect.Method m : btnClass.getDeclaredMethods()) {
                if (builderNames.contains(m.getName()) && m.getParameterCount() == 2
                        && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    builderMethod = m; break;
                }
            }
            if (builderMethod == null) {
                StringBuilder cands = new StringBuilder();
                for (java.lang.reflect.Method m : btnClass.getDeclaredMethods()) {
                    if (m.getParameterCount() == 2 && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                        cands.append(m.getName()).append('(').append(m.getParameterTypes()[0].getSimpleName())
                            .append(',').append(m.getParameterTypes()[1].getSimpleName()).append(") ");
                    }
                }
                LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: builderMethod introuvable. Candidates statiques 2-arg sur " + btnClassName + ": " + cands);
                return null;
            }
            Object builder = builderMethod.invoke(null, comp, onPress);
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: builder=" + builder);

            // Button$Builder.dimensions(IIII) et .build() portent tous les deux
            // le nom officiel "a" (overloads distingués par descripteur — voir
            // mappings.tiny classe "gje$a") — DIFFÉRENT du "a" de Button.builder()
            // ci-dessus (classe "gje"), d'où l'usage de CLS_BUTTON_BUILDER ici et
            // non plus une recherche heuristique par signature seule.
            java.util.Set<String> bldNames = MappingsRegistry.runtimeMethodNames(CLS_BUTTON_BUILDER, "a");
            Class<?> bldClass = builder.getClass();
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: bldClass=" + bldClass.getName() + " bldNames=" + bldNames);
            java.lang.reflect.Method boundsMethod = null;
            for (java.lang.reflect.Method m : bldClass.getMethods()) {
                if (!bldNames.contains(m.getName()) || m.getParameterCount() != 4) continue;
                Class<?>[] pt = m.getParameterTypes();
                if (pt[0] == int.class && pt[1] == int.class && pt[2] == int.class && pt[3] == int.class) {
                    boundsMethod = m; break;
                }
            }
            if (boundsMethod == null) {
                LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: boundsMethod (dimensions) introuvable parmi " + bldNames + " sur " + bldClass.getName());
                return null;
            }
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: boundsMethod=" + boundsMethod);
            Object bld2 = boundsMethod.invoke(builder, x, y, w, h);
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: bld2=" + bld2 + " (classe=" + (bld2 == null ? "null" : bld2.getClass().getName()) + ")");

            java.lang.reflect.Method buildMethod = null;
            for (java.lang.reflect.Method m : bldClass.getMethods()) {
                if (bldNames.contains(m.getName()) && m.getParameterCount() == 0
                        && btnClass.isAssignableFrom(m.getReturnType())) {
                    buildMethod = m; break;
                }
            }
            if (buildMethod == null) {
                LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: buildMethod (build) introuvable parmi " + bldNames + " sur " + bldClass.getName());
                return null;
            }
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: buildMethod=" + buildMethod);
            Object widget = buildMethod.invoke(bld2);
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: widget=" + widget + " (classe=" + (widget == null ? "null" : widget.getClass().getName()) + ")");
            Object added = addWidget(screen, widget);
            LauncherLog.ui(1, "[LauncherAgent-Screen] addButton: addWidget a renvoyé " + added);
            return added;
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] addButton: " + e); }
        return null;
    }

    // ── EditBox ───────────────────────────────────────────────────────────────

    public static Object createEditBox(Object screen, int x, int y, int w, int h) {
        try {
            ClassLoader cl = screen.getClass().getClassLoader();
            Object font = getField(screen, CLS_SCREEN, "q");
            Object narration = literal(cl, "");
            if (font == null || narration == null) return null;

            Class<?> editClass = Class.forName(MappingsRegistry.runtimeClass(CLS_EDIT_BOX), true, cl);
            for (java.lang.reflect.Constructor<?> c : editClass.getDeclaredConstructors()) {
                if (c.getParameterCount() == 6) {
                    c.setAccessible(true);
                    return c.newInstance(font, x, y, w, h, narration);
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] createEditBox: " + e); }
        return null;
    }

    public static void setEditBoxHint(Object editBox, String hint) {
        if (editBox == null) return;
        try {
            ClassLoader mcCl = editBox.getClass().getClassLoader();
            Object hintComp = literal(mcCl, hint);
            if (hintComp == null) return;
            Class<?> c = editBox.getClass();
            while (c != null && !c.getName().equals("java.lang.Object")) {
                for (java.lang.reflect.Method m : c.getDeclaredMethods()) {
                    if (m.getParameterCount() == 1 && !m.getParameterTypes()[0].isPrimitive()
                            && m.getReturnType() == void.class
                            && m.getParameterTypes()[0].isInstance(hintComp)) {
                        m.setAccessible(true);
                        try { m.invoke(editBox, hintComp); return; }
                        catch (Exception ignored) {}
                    }
                }
                c = c.getSuperclass();
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] setEditBoxHint: " + e); }
    }

    public static void setEditBoxMaxLength(Object editBox, int maxLen) {
        if (editBox == null) return;
        try {
            for (java.lang.reflect.Method m : editBox.getClass().getMethods()) {
                if (m.getParameterCount() == 1 && m.getParameterTypes()[0] == int.class
                        && m.getReturnType() == void.class
                        && !m.getDeclaringClass().equals(Object.class)) {
                    m.invoke(editBox, maxLen); return;
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] setMaxLength: " + e); }
    }

    public static String editBoxValue(Object editBox) {
        if (editBox == null) return null;
        try {
            java.util.Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_EDIT_BOX, "a");
            for (java.lang.reflect.Method m : editBox.getClass().getMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 0
                        && m.getReturnType() == String.class) {
                    Object v = m.invoke(editBox);
                    return v instanceof String ? (String) v : null;
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] editBoxValue: " + e); }
        return null;
    }

    // ── Widget helpers ────────────────────────────────────────────────────────

    public static void setButtonLabel(Object screen, Object btn, String label) {
        if (btn == null) return;
        try {
            ClassLoader cl = screen.getClass().getClassLoader();
            Object comp = literal(cl, label);
            setButtonMessage(btn, comp);
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] setLabel: " + e); }
    }

    /**
     * Comme setButtonLabel, mais avec un Text DÉJÀ construit (pas une chaîne à
     * envelopper via literal()) — utile pour réafficher un Text obtenu
     * directement de vanilla (ex: KeyBinding.getBoundKeyLocalizedText()), qui
     * porte déjà la bonne localisation/mise en forme, sans repasser par une
     * reconstruction littérale qui la perdrait.
     */
    public static void setButtonMessage(Object btn, Object textComponent) {
        if (btn == null || textComponent == null) return;
        try {
            java.util.Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_CLICKABLE, "a_");
            for (java.lang.reflect.Method m : btn.getClass().getMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 1) {
                    m.invoke(btn, textComponent); return;
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] setButtonMessage: " + e); }
    }

    public static void setActive(Object btn, boolean active) {
        setBooleanField(btn, CLS_CLICKABLE, "k", active, "setActive");
    }

    /**
     * ClickableWidget.visible ("l" dans les mappings) — distinct de "active" :
     * un widget inactif reste dessiné (rectangle grisé), un widget invisible ne
     * l'est pas du tout. Utilisé pour cacher les slots de résultats vides plutôt
     * que de les laisser s'afficher comme des cases grises vides.
     */
    public static void setVisible(Object btn, boolean visible) {
        setBooleanField(btn, CLS_CLICKABLE, "l", visible, "setVisible");
    }

    private static void setBooleanField(Object btn, String officialOwner, String officialField,
                                          boolean value, String logTag) {
        if (btn == null) return;
        String fieldName = MappingsRegistry.runtimeField(officialOwner, officialField);
        try {
            Class<?> c = btn.getClass();
            while (c != null) {
                try {
                    java.lang.reflect.Field f = c.getDeclaredField(fieldName);
                    f.setAccessible(true); f.setBoolean(btn, value); return;
                } catch (NoSuchFieldException ignored) { c = c.getSuperclass(); }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] " + logTag + ": " + e); }
    }

    /**
     * Déplace un widget — champs ClickableWidget.x ("a") et .y ("b"). Permet de
     * faire vraiment glisser des widgets pour simuler un scroll (plutôt que de
     * réutiliser un nombre fixe de slots dont seul le texte change), sans avoir
     * à toucher au pipeline de rendu (DrawContext/scissor non utilisés ici).
     */
    public static void setPosition(Object btn, int x, int y) {
        if (btn == null) return;
        String fieldX = MappingsRegistry.runtimeField(CLS_CLICKABLE, "a");
        String fieldY = MappingsRegistry.runtimeField(CLS_CLICKABLE, "b");
        try {
            Class<?> c = btn.getClass();
            while (c != null) {
                try {
                    java.lang.reflect.Field fx = c.getDeclaredField(fieldX);
                    java.lang.reflect.Field fy = c.getDeclaredField(fieldY);
                    if (fx.getType() == int.class && fy.getType() == int.class) {
                        fx.setAccessible(true); fy.setAccessible(true);
                        fx.setInt(btn, x); fy.setInt(btn, y);
                        return;
                    }
                    c = c.getSuperclass();
                } catch (NoSuchFieldException ignored) { c = c.getSuperclass(); }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] setPosition: " + e); }
    }

    // ── Screen dimensions ─────────────────────────────────────────────────────

    public static int getWidth(Object screen) {
        Object v = getField(screen, CLS_SCREEN, "o");
        return v instanceof Integer ? (int) v : 320;
    }

    public static int getHeight(Object screen) {
        Object v = getField(screen, CLS_SCREEN, "p");
        return v instanceof Integer ? (int) v : 240;
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    /** Navigue vers targetScreen via minecraft.setScreen(). */
    public static void navigate(Object currentScreen, Object targetScreen) {
        try {
            Object mc = getMc(currentScreen);
            if (mc == null) { LauncherLog.warn("[LauncherAgent-Screen] navigate: mc null"); return; }

            if (targetScreen == null) {
                Class<?> screenType = currentScreen.getClass();
                for (java.lang.reflect.Method m : mc.getClass().getMethods()) {
                    if (m.getParameterCount() != 1 || m.getReturnType() != Void.TYPE) continue;
                    Class<?> pt = m.getParameterTypes()[0];
                    if (pt.isPrimitive()) continue;
                    if (pt.isAssignableFrom(screenType)) {
                        try { m.invoke(mc, (Object) null); return; }
                        catch (Exception ignored) {}
                    }
                }
                return;
            }

            for (java.lang.reflect.Method m : mc.getClass().getMethods()) {
                if (m.getParameterCount() != 1 || m.getReturnType() != Void.TYPE) continue;
                Class<?> pt = m.getParameterTypes()[0];
                if (pt.isPrimitive()) continue;
                if (pt.isAssignableFrom(targetScreen.getClass())) {
                    try { m.invoke(mc, targetScreen); return; }
                    catch (Exception ignored) {}
                }
            }
            LauncherLog.warn("[LauncherAgent-Screen] navigate: setScreen introuvable");
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] navigate: " + e); }
    }

    /** Instance Minecraft.getInstance() associée à cet écran (champ ou fallback statique). */
    public static Object getMc(Object screen) {
        try {
            String mcClassName = MappingsRegistry.runtimeClass(CLS_MINECRAFT_CLIENT);
            Class<?> cls = screen.getClass();
            while (cls != null && !cls.getName().equals("java.lang.Object")) {
                for (java.lang.reflect.Field f : cls.getDeclaredFields()) {
                    f.setAccessible(true);
                    try {
                        Object val = f.get(screen);
                        if (val != null && val.getClass().getName().equals(mcClassName)) return val;
                    } catch (Exception ignored) {}
                }
                cls = cls.getSuperclass();
            }
            ClassLoader cl = screen.getClass().getClassLoader();
            Class<?> mcClass = Class.forName(mcClassName, true, cl);
            for (java.lang.reflect.Method m : mcClass.getDeclaredMethods()) {
                if (m.getParameterCount() == 0 && java.lang.reflect.Modifier.isStatic(m.getModifiers())) {
                    m.setAccessible(true);
                    Object mc = m.invoke(null);
                    if (mc != null) return mc;
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] getMc: " + e); }
        return null;
    }

    private static final String CLS_WINDOW = "fyk"; // net.minecraft.client.util.Window

    /**
     * Largeur "scaled" (unités GUI) de la fenêtre du jeu, lue directement sur
     * MinecraftClient.window.getScaledWidth() — PAS Screen.width (champ "o"),
     * qui reste à 0 tant que Minecraft n'a pas appelé
     * init(client, width, height) (après le constructeur, donc inutilisable
     * pour positionner un widget ajouté dans un @Inject sur le constructeur,
     * comme KeybindsScreenMixin). La fenêtre, elle, existe déjà à ce moment.
     */
    public static int getScaledWindowWidth(Object screen) {
        try {
            Object mc = getMc(screen);
            if (mc == null) return 0;
            Object window = getField(mc, CLS_MINECRAFT_CLIENT, "O");
            if (window == null) return 0;
            java.util.Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_WINDOW, "o");
            for (java.lang.reflect.Method m : window.getClass().getMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 0 && m.getReturnType() == int.class) {
                    return (int) m.invoke(window);
                }
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] getScaledWindowWidth: " + e);
        }
        return 0;
    }

    /**
     * MinecraftClient.runDirectory ("p") — dossier de l'instance en cours
     * (resourcepacks/shaderpacks/options... y vivent), pas le ".minecraft"
     * global : chaque instance YuyuFrame lance le jeu avec son propre dossier
     * de run, donc ce champ pointe déjà au bon endroit sans logique
     * supplémentaire côté agent.
     */
    public static java.io.File getRunDirectory(Object screen) {
        Object mc = getMc(screen);
        if (mc == null) return null;
        Object v = getField(mc, CLS_MINECRAFT_CLIENT, "p");
        return v instanceof java.io.File ? (java.io.File) v : null;
    }

    /**
     * Planifie {@code task} sur le thread principal MC via Executor.execute()
     * — jamais obfusqué par ProGuard (contrat de l'interface JDK). Permet à un
     * thread de fond (recherche/téléchargement Modrinth) de mettre à jour les
     * widgets en sécurité, sans toucher au rendu depuis un autre thread.
     */
    public static void executeOnMc(Object mc, Runnable task) {
        if (mc == null) { task.run(); return; }
        try {
            for (java.lang.reflect.Method m : mc.getClass().getMethods()) {
                if ("execute".equals(m.getName()) && m.getParameterCount() == 1
                        && m.getParameterTypes()[0] == Runnable.class) {
                    m.invoke(mc, task);
                    return;
                }
            }
        } catch (Exception e) { LauncherLog.warn("[LauncherAgent-Screen] executeOnMc: " + e); }
        task.run();
    }

    /**
     * Trouve le bord gauche (X minimal) de la rangée de widgets la plus basse
     * déjà présente sur l'écran (typiquement "Open Pack Folder"/"Done") —
     * cherche le Y maximal réellement observé plutôt que de deviner sa valeur
     * (h-28 ou autre formule qui peut changer selon la version MC ou l'écran),
     * puis prend le X minimal des widgets à ce Y (tolérance ±4px). Retourne
     * {@code null} si aucun widget positionné n'est trouvé (champ "children"
     * absent/renommé) — l'appelant doit prévoir un repli fixe dans ce cas.
     *
     * @param targetY ignoré pour la recherche du Y (on prend le Y max observé),
     *                conservé en repli si la liste de widgets est vide/introuvable.
     */
    public static int[] findBottomRow(Object screen, int targetY) {
        try {
            java.util.List<?> list = findListField(screen, CLS_SCREEN, "d");
            if (list == null) return null;

            int maxY = Integer.MIN_VALUE;
            java.util.List<int[]> points = new java.util.ArrayList<>();
            for (Object child : list) {
                if (child == null) continue;
                Integer y = getIntFieldWalk(child, CLS_CLICKABLE, "b");
                Integer x = getIntFieldWalk(child, CLS_CLICKABLE, "a");
                if (y == null || x == null) continue;
                points.add(new int[]{x, y});
                if (y > maxY) maxY = y;
            }
            if (points.isEmpty()) return null;

            int minX = Integer.MAX_VALUE;
            for (int[] p : points) {
                if (Math.abs(p[1] - maxY) <= 4) minX = Math.min(minX, p[0]);
            }
            return new int[]{minX, maxY};
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Screen] findBottomRow: " + e);
            return null;
        }
    }

    /**
     * Comme getField, mais continue de remonter la hiérarchie si un champ du
     * même nom existe mais n'est pas du type attendu (java.util.List) — "d"
     * est un nom à une lettre réutilisé pour des champs sans rapport à
     * différents niveaux de la hiérarchie ; s'arrêter au premier trouvé sans
     * vérifier le type renvoie silencieusement la mauvaise valeur.
     */
    private static java.util.List<?> findListField(Object obj, String officialOwner, String officialField) {
        String fieldName = MappingsRegistry.runtimeField(officialOwner, officialField);
        Class<?> c = obj.getClass();
        while (c != null) {
            try {
                java.lang.reflect.Field f = c.getDeclaredField(fieldName);
                if (java.util.List.class.isAssignableFrom(f.getType())) {
                    f.setAccessible(true);
                    Object v = f.get(obj);
                    if (v instanceof java.util.List<?> l) return l;
                }
            } catch (NoSuchFieldException ignored) {}
            catch (IllegalAccessException ignored) {}
            c = c.getSuperclass();
        }
        return null;
    }

    private static Integer getIntFieldWalk(Object obj, String officialOwner, String officialField) {
        String fieldName = MappingsRegistry.runtimeField(officialOwner, officialField);
        Class<?> c = obj.getClass();
        while (c != null) {
            try {
                java.lang.reflect.Field f = c.getDeclaredField(fieldName);
                if (f.getType() == int.class) {
                    f.setAccessible(true);
                    return f.getInt(obj);
                }
                return null;
            } catch (NoSuchFieldException ignored) { c = c.getSuperclass(); }
            catch (IllegalAccessException e) { return null; }
        }
        return null;
    }

    // ── Internes ──────────────────────────────────────────────────────────────

    /** getField générique avec classe propriétaire connue (traduite via MappingsRegistry). */
    public static Object getField(Object obj, String officialOwner, String officialField) {
        String fieldName = MappingsRegistry.runtimeField(officialOwner, officialField);
        try {
            Class<?> c = obj.getClass();
            while (c != null) {
                try {
                    java.lang.reflect.Field f = c.getDeclaredField(fieldName);
                    f.setAccessible(true);
                    return f.get(obj);
                } catch (NoSuchFieldException ignored) { c = c.getSuperclass(); }
            }
        } catch (Exception ignored) {}
        return null;
    }
}
