package com.yuyuframe.launcheragent.screen;

import com.yuyuframe.launcheragent.runtime.keybind.KeybindReflect;
import com.yuyuframe.launcheragent.runtime.keybind.KeybindSettings;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.screen.ScreenHelper;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Écran Touches maison, remplace entièrement l'écran vanilla (voir
 * KeybindsScreenMixin) — catégories repliables, recherche, masquage des
 * touches non assignées, mise en évidence des doublons, et le rebind lui-même.
 *
 * Le rebind n'utilise PAS Screen.keyPressed() (signature désormais basée sur
 * un type record "KeyInput" sans stub compilable, comme "Click" pour la
 * souris) : on poll l'état GLFW des touches via InputUtil.isKeyPressed()
 * chaque tick (voir tick()/ScreenStubPatcher) pendant le mode "écoute" — même
 * mécanisme qu'utilise KeyBinding.isPressed() en interne, juste invoqué nous-
 * mêmes pendant que l'écran est ouvert. Clavier uniquement pour cette v1 (pas
 * de rebind à un bouton de souris) — limitation connue, extensible plus tard.
 */
public class CustomKeybindsScreen extends Screen {

    private static final int HEADER_HEIGHT = 18;
    private static final int ROW_HEIGHT = 20;
    private static final int GAP = 3;
    private static final int FOOTER_HEIGHT = 56; // barre d'outils + Reset All Keys
    private static final int GLFW_KEY_ESCAPE = 256;
    private static final int GLFW_KEY_FIRST = 32;
    private static final int GLFW_KEY_LAST = 348;

    private final Object lastScreen;
    private final Object mc;
    private final ClassLoader cl;

    private static final class Row {
        final Object binding;
        final String id;
        final Object nameText; // Text traduit, mis en cache (évite de re-traduire à chaque repositionnement)
        Object nameLabel, keyButton, resetButton;
        int nameX, keyX, resetX;
        Row(Object binding, String id, Object nameText) {
            this.binding = binding; this.id = id; this.nameText = nameText;
        }
    }

    private static final class Group {
        final String id;
        final String label;
        final List<Row> rows = new ArrayList<>();
        Object headerButton;
        Group(String id, String label) { this.id = id; this.label = label; }
    }

    private static final int CONTENT_X = 8;

    private final List<Group> groups = new ArrayList<>();

    private Object searchBox;
    private Object toggleUnboundButton;
    private Object toggleConflictsButton;

    private int viewportTop, viewportBottom;
    private int scrollOffset = 0;
    private boolean showConflictsOnly = false;
    private String searchText = "";

    private boolean listening = false;
    private Row listeningRow;
    private final boolean[] prevKeyState = new boolean[GLFW_KEY_LAST + 1];

    public CustomKeybindsScreen(Object lastScreen) {
        super((Component) ScreenHelper.literal("Touches"));
        this.lastScreen = lastScreen;
        this.mc = ScreenHelper.getMc(this);
        this.cl = this.getClass().getClassLoader();
        buildModel();
    }

    /** Construit groupes/lignes UNE SEULE FOIS (les objets KeyBinding/Category sont stables) — pas refait à chaque resize. */
    private void buildModel() {
        Map<String, Group> byId = new java.util.LinkedHashMap<>();
        for (Object category : KeybindReflect.getAllCategories(cl)) {
            String catId = KeybindReflect.getCategoryId(category);
            if (catId == null) continue;
            String name = ScreenHelper.textToPlainString(KeybindReflect.getCategoryLabel(category));
            if (name == null || name.isEmpty()) name = deriveNameFromId(catId);
            byId.put(catId, new Group(catId, name));
        }
        for (Object binding : KeybindReflect.getAllKeyBindings(cl)) {
            Object category = KeybindReflect.getCategory(binding);
            String catId = KeybindReflect.getCategoryId(category);
            Group g = catId == null ? null : byId.get(catId);
            if (g == null) continue; // catégorie inconnue (ne devrait pas arriver) — ligne ignorée plutôt que de planter
            String id = KeybindReflect.getId(binding);
            Object nameText = id == null ? null : ScreenHelper.translatable(cl, id);
            g.rows.add(new Row(binding, id, nameText));
        }
        for (Group g : byId.values()) {
            if (!g.rows.isEmpty()) groups.add(g);
        }
        LauncherLog.ui(3, "[LauncherAgent] CustomKeybindsScreen: " + groups.size() + " catégorie(s), "
            + groups.stream().mapToInt(g -> g.rows.size()).sum() + " touche(s)");
    }

    private static String deriveNameFromId(String categoryId) {
        String name = categoryId.contains(":") ? categoryId.substring(categoryId.indexOf(':') + 1) : categoryId;
        name = name.replace('_', ' ');
        if (!name.isEmpty()) name = Character.toUpperCase(name.charAt(0)) + name.substring(1);
        return name;
    }

    public void bg_() {
        int w = ScreenHelper.getWidth(this);
        int h = ScreenHelper.getHeight(this);

        ScreenHelper.addTitleLabel(this, "§lTouches", 8);

        searchBox = ScreenHelper.createEditBox(this, CONTENT_X, 28, 200, 18);
        if (searchBox != null) {
            ScreenHelper.setEditBoxMaxLength(searchBox, 64);
            ScreenHelper.addWidget(this, searchBox);
            ScreenHelper.setEditBoxHint(searchBox, "Rechercher...");
        }
        ScreenHelper.addButton(this, CONTENT_X + 204, 28, 80, 18, "Rechercher", this::handleSearch);

        boolean showUnbound = KeybindSettings.isShowUnbound();
        toggleUnboundButton = ScreenHelper.addButton(this, w - 160, 28, 152, 18,
            showUnbound ? "Cacher non liées" : "Afficher non liées", this::onToggleUnbound);

        viewportTop = 52;
        viewportBottom = h - FOOTER_HEIGHT;

        int innerWidth = w - CONTENT_X * 2;
        int nameWidth = Math.max(120, (int) (innerWidth * 0.5));
        int keyWidth = 130;
        int gapX = 6;
        int keyX = CONTENT_X + nameWidth + gapX;
        int resetX = keyX + keyWidth + gapX;
        int resetWidth = Math.max(50, innerWidth - (resetX - CONTENT_X));

        for (Group g : groups) {
            g.headerButton = ScreenHelper.addButton(this, CONTENT_X, viewportTop, innerWidth, HEADER_HEIGHT,
                groupLabel(g), () -> onToggleGroup(g));
            for (Row r : g.rows) {
                r.nameX = CONTENT_X;
                r.keyX = keyX;
                r.resetX = resetX;

                r.nameLabel = ScreenHelper.addButton(this, r.nameX, viewportTop, nameWidth, ROW_HEIGHT, "", () -> {});
                ScreenHelper.setActive(r.nameLabel, false);
                if (r.nameText != null) ScreenHelper.setButtonMessage(r.nameLabel, r.nameText);

                r.keyButton = ScreenHelper.addButton(this, r.keyX, viewportTop, keyWidth, ROW_HEIGHT, "",
                    () -> onClickKey(r));
                refreshKeyLabel(r);

                r.resetButton = ScreenHelper.addButton(this, r.resetX, viewportTop, resetWidth, ROW_HEIGHT, "Reset",
                    () -> onResetRow(r));
            }
        }

        toggleConflictsButton = ScreenHelper.addButton(this, CONTENT_X, h - FOOTER_HEIGHT + 6, 150, 18,
            showConflictsOnly ? "Doublons : oui" : "Doublons : tous", this::onToggleConflicts);
        ScreenHelper.addButton(this, CONTENT_X + 156, h - FOOTER_HEIGHT + 6, 150, 18, "Tri : à venir", () -> {});
        ScreenHelper.addButton(this, w - 158, h - FOOTER_HEIGHT + 6, 150, 18, "Terminé", this::onDone);

        ScreenHelper.addButton(this, CONTENT_X, h - FOOTER_HEIGHT + 28, innerWidth, 18,
            "Réinitialiser toutes les touches", this::onResetAll);

        repositionAll();
    }

    // ── Molette : déplace réellement les widgets visibles (même principe que ResourcePackSearchScreen). ──
    public boolean a(double mouseX, double mouseY, double horizontalAmount, double verticalAmount) {
        int delta = verticalAmount > 0 ? -1 : (verticalAmount < 0 ? 1 : 0);
        if (delta == 0) return false;
        scrollOffset += delta * (ROW_HEIGHT + GAP);
        repositionAll();
        return true;
    }

    /** Screen.tick() (renommé par ScreenStubPatcher) — poll GLFW pendant le mode écoute. Voir doc de classe. */
    public void tick() {
        if (!listening) return;
        try {
            Object window = KeybindReflect.getWindow(mc);
            if (window == null) return;
            for (int code = GLFW_KEY_FIRST; code <= GLFW_KEY_LAST; code++) {
                boolean pressed = KeybindReflect.isWindowKeyPressed(window, code, cl);
                boolean wasPressed = prevKeyState[code];
                prevKeyState[code] = pressed;
                if (pressed && !wasPressed) {
                    if (code == GLFW_KEY_ESCAPE) {
                        cancelListening();
                    } else {
                        applyListeningKey(code);
                    }
                    return; // un seul événement traité par tick, évite les doubles captures
                }
            }
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] CustomKeybindsScreen tick: " + t);
        }
    }

    /** Screen.shouldCloseOnEsc() (renommé par ScreenStubPatcher) — Échap annule l'écoute SANS fermer l'écran. */
    public boolean shouldCloseOnEsc() {
        return !listening;
    }

    // ── Recherche / filtres ──────────────────────────────────────────────────

    private void handleSearch() {
        String v = ScreenHelper.editBoxValue(searchBox);
        searchText = (v == null ? "" : v.trim()).toLowerCase();
        repositionAll();
    }

    private void onToggleUnbound() {
        KeybindSettings.setShowUnbound(!KeybindSettings.isShowUnbound());
        ScreenHelper.setButtonLabel(this, toggleUnboundButton,
            KeybindSettings.isShowUnbound() ? "Cacher non liées" : "Afficher non liées");
        repositionAll();
    }

    private void onToggleConflicts() {
        showConflictsOnly = !showConflictsOnly;
        ScreenHelper.setButtonLabel(this, toggleConflictsButton,
            showConflictsOnly ? "Doublons : oui" : "Doublons : tous");
        repositionAll();
    }

    private void onToggleGroup(Group g) {
        KeybindSettings.setCategoryExpanded(g.id, !KeybindSettings.isCategoryExpanded(g.id));
        ScreenHelper.setButtonLabel(this, g.headerButton, groupLabel(g));
        repositionAll();
    }

    private String groupLabel(Group g) {
        boolean expanded = KeybindSettings.isCategoryExpanded(g.id);
        return (expanded ? "▼ " : "▶ ") + g.label + "  §7(" + g.rows.size() + " touche(s))";
    }

    // ── Rebind ───────────────────────────────────────────────────────────────

    private void onClickKey(Row r) {
        if (listening) cancelListening();
        listening = true;
        listeningRow = r;
        java.util.Arrays.fill(prevKeyState, false);
        // Baseline : toute touche déjà tenue avant le clic ne doit pas être
        // capturée comme "nouvelle" pression dès le tick suivant.
        Object window = KeybindReflect.getWindow(mc);
        if (window != null) {
            for (int code = GLFW_KEY_FIRST; code <= GLFW_KEY_LAST; code++) {
                prevKeyState[code] = KeybindReflect.isWindowKeyPressed(window, code, cl);
            }
        }
        ScreenHelper.setButtonLabel(this, r.keyButton, "> Appuyez sur une touche <");
    }

    private void cancelListening() {
        if (!listening) return;
        listening = false;
        Row r = listeningRow;
        listeningRow = null;
        if (r != null) refreshKeyLabel(r);
    }

    private void applyListeningKey(int glfwCode) {
        Row r = listeningRow;
        listening = false;
        listeningRow = null;
        if (r == null) return;
        KeybindReflect.setBoundKeyFromGlfwCode(r.binding, glfwCode, cl);
        KeybindReflect.updateKeysByCode(cl);
        saveOptions();
        refreshKeyLabel(r);
        repositionAll(); // les conflits affichés peuvent avoir changé
    }

    private void onResetRow(Row r) {
        KeybindReflect.resetBinding(r.binding);
        KeybindReflect.updateKeysByCode(cl);
        saveOptions();
        refreshKeyLabel(r);
        repositionAll();
    }

    private void onResetAll() {
        for (Group g : groups) for (Row r : g.rows) KeybindReflect.resetBinding(r.binding);
        KeybindReflect.updateKeysByCode(cl);
        saveOptions();
        for (Group g : groups) for (Row r : g.rows) refreshKeyLabel(r);
        repositionAll();
    }

    private void onDone() {
        if (listening) cancelListening();
        saveOptions();
        ScreenHelper.navigate(this, lastScreen);
    }

    private void refreshKeyLabel(Row r) {
        Object text = KeybindReflect.getBoundKeyLocalizedText(r.binding);
        if (text != null) ScreenHelper.setButtonMessage(r.keyButton, text);
    }

    private void saveOptions() {
        Object options = KeybindReflect.getOptions(mc);
        if (options != null) KeybindReflect.writeOptions(options);
    }

    // ── Mise en page / scroll ────────────────────────────────────────────────

    private boolean rowVisible(Row r, Set<String> conflictKeys) {
        if (!KeybindSettings.isShowUnbound() && KeybindReflect.isUnbound(r.binding)) return false;
        if (showConflictsOnly) {
            String key = KeybindReflect.getBoundKeyTranslationKey(r.binding);
            if (key == null || !conflictKeys.contains(key)) return false;
        }
        if (!searchText.isEmpty()) {
            String name = ScreenHelper.textToPlainString(r.nameText).toLowerCase();
            boolean idMatch = r.id != null && r.id.toLowerCase().contains(searchText);
            if (!name.contains(searchText) && !idMatch) return false;
        }
        return true;
    }

    private Set<String> computeConflictKeys() {
        if (!showConflictsOnly) return Set.of();
        Map<String, Integer> counts = new HashMap<>();
        for (Group g : groups) for (Row r : g.rows) {
            String key = KeybindReflect.getBoundKeyTranslationKey(r.binding);
            if (key != null) counts.merge(key, 1, Integer::sum);
        }
        Set<String> conflicts = new HashSet<>();
        for (var e : counts.entrySet()) if (e.getValue() > 1) conflicts.add(e.getKey());
        return conflicts;
    }

    private void repositionAll() {
        Set<String> conflictKeys = computeConflictKeys();

        // Passe 1 : hauteur totale du contenu (scrollOffset=0) pour bloquer le scroll.
        int y = 0;
        for (Group g : groups) {
            if (!groupVisible(g, conflictKeys)) continue;
            y += HEADER_HEIGHT + GAP;
            if (KeybindSettings.isCategoryExpanded(g.id)) {
                for (Row r : g.rows) {
                    if (rowVisible(r, conflictKeys)) y += ROW_HEIGHT + GAP;
                }
            }
        }
        int viewportHeight = Math.max(1, viewportBottom - viewportTop);
        int maxScroll = Math.max(0, y - viewportHeight);
        scrollOffset = Math.max(0, Math.min(maxScroll, scrollOffset));

        // Passe 2 : position/visibilité réelles des widgets.
        y = viewportTop - scrollOffset;
        for (Group g : groups) {
            boolean gVisible = groupVisible(g, conflictKeys);
            if (!gVisible) {
                ScreenHelper.setVisible(g.headerButton, false);
                for (Row r : g.rows) hideRow(r);
                continue;
            }

            boolean headerInViewport = y + HEADER_HEIGHT > viewportTop && y < viewportBottom;
            ScreenHelper.setPosition(g.headerButton, CONTENT_X, y);
            ScreenHelper.setVisible(g.headerButton, headerInViewport);
            y += HEADER_HEIGHT + GAP;

            boolean expanded = KeybindSettings.isCategoryExpanded(g.id);
            for (Row r : g.rows) {
                if (!expanded || !rowVisible(r, conflictKeys)) { hideRow(r); continue; }
                boolean rowInViewport = y + ROW_HEIGHT > viewportTop && y < viewportBottom;
                ScreenHelper.setPosition(r.nameLabel, r.nameX, y);
                ScreenHelper.setPosition(r.keyButton, r.keyX, y);
                ScreenHelper.setPosition(r.resetButton, r.resetX, y);
                ScreenHelper.setVisible(r.nameLabel, rowInViewport);
                ScreenHelper.setVisible(r.keyButton, rowInViewport);
                ScreenHelper.setVisible(r.resetButton, rowInViewport);
                y += ROW_HEIGHT + GAP;
            }
        }
    }

    private boolean groupVisible(Group g, Set<String> conflictKeys) {
        for (Row r : g.rows) if (rowVisible(r, conflictKeys)) return true;
        return false;
    }

    private void hideRow(Row r) {
        ScreenHelper.setVisible(r.nameLabel, false);
        ScreenHelper.setVisible(r.keyButton, false);
        ScreenHelper.setVisible(r.resetButton, false);
    }
}
