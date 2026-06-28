package com.yuyuframe.launcheragent.runtime.keybind;

import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.mapping.MappingsRegistry;
import com.yuyuframe.launcheragent.runtime.screen.ScreenHelper;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Réflexion partagée pour CustomKeybindsScreen (écran maison qui remplace
 * entièrement l'écran vanilla — voir KeybindsScreenMixin) — modèle
 * KeyBinding/Category/InputUtil, lecture/écriture des touches assignées.
 * Même pattern que ScreenHelper (littéraux "official", traduits via
 * MappingsRegistry.runtime*()).
 */
public final class KeybindReflect {

    private KeybindReflect() {}

    private static final String CLS_KEYBINDING            = "gfh"; // KeyBinding
    private static final String CLS_CATEGORY              = "gfh$a"; // KeyBinding$Category
    private static final String CLS_INPUT_UTIL            = "fyc"; // InputUtil
    private static final String CLS_INPUT_TYPE            = "fyc$b"; // InputUtil$Type
    private static final String CLS_MINECRAFT_CLIENT      = "gfj"; // MinecraftClient
    private static final String CLS_GAME_OPTIONS          = "gfo"; // GameOptions

    // ── KeyBinding ───────────────────────────────────────────────────────────

    /** KeyBinding.KEYS_BY_ID ("b", static, Map<String,KeyBinding>) — tous les bindings enregistrés (vanilla + mods). */
    @SuppressWarnings("unchecked")
    public static List<Object> getAllKeyBindings(ClassLoader cl) {
        try {
            Class<?> kbClass = Class.forName(MappingsRegistry.runtimeClass(CLS_KEYBINDING), true, cl);
            String fieldName = MappingsRegistry.runtimeField(CLS_KEYBINDING, "b");
            Field f = kbClass.getDeclaredField(fieldName);
            f.setAccessible(true);
            Object v = f.get(null);
            if (v instanceof Map<?, ?> map) return new ArrayList<>(map.values());
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] getAllKeyBindings: " + e);
        }
        return List.of();
    }

    /** KeyBinding.getId() ("k", ()Ljava/lang/String;). */
    public static String getId(Object keyBinding) {
        return (String) invoke0(keyBinding, CLS_KEYBINDING, "k");
    }

    /** KeyBinding.isUnbound() ("m", ()Z). */
    public static boolean isUnbound(Object keyBinding) {
        Object r = invoke0(keyBinding, CLS_KEYBINDING, "m");
        return r instanceof Boolean b && b;
    }

    /** KeyBinding.getBoundKeyLocalizedText() ("n", ()Lyh;) — Text déjà localisé/formaté pour affichage. */
    public static Object getBoundKeyLocalizedText(Object keyBinding) {
        return invoke0(keyBinding, CLS_KEYBINDING, "n");
    }

    /** KeyBinding.isDefault() ("o", ()Z) — la touche assignée est-elle celle par défaut. */
    public static boolean isDefault(Object keyBinding) {
        Object r = invoke0(keyBinding, CLS_KEYBINDING, "o");
        return r instanceof Boolean b && b;
    }

    /** KeyBinding.reset() ("i", ()V) — remet CETTE touche à sa valeur par défaut (appeler updateKeysByCode() après). */
    public static void resetBinding(Object keyBinding) {
        invoke0(keyBinding, CLS_KEYBINDING, "i");
    }

    /**
     * KeyBinding.boundKey.getTranslationKey() — clé stable identifiant la
     * touche assignée (pas l'objet Key lui-même, pour pouvoir s'en servir
     * comme clé de Map lors de la détection de doublons). {@code null} si
     * non assignée (le "Show conflicts" ne doit alors jamais la compter).
     */
    public static String getBoundKeyTranslationKey(Object keyBinding) {
        if (keyBinding == null || isUnbound(keyBinding)) return null;
        try {
            String fieldName = MappingsRegistry.runtimeField(CLS_KEYBINDING, "a");
            Field f = keyBinding.getClass().getDeclaredField(fieldName);
            f.setAccessible(true);
            Object key = f.get(keyBinding);
            return (String) invoke0(key, "fyc$a", "c");
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] getBoundKeyTranslationKey: " + e);
            return null;
        }
    }

    /**
     * KeyBinding.category ("f", type KeyBinding$Category). Remonte la
     * hiérarchie de classes : certains mods enregistrent leurs touches via une
     * SOUS-CLASSE de KeyBinding (ex: touches "sticky"/toggle), où "category"
     * reste déclaré sur KeyBinding lui-même — getDeclaredField() direct sur la
     * classe concrète échoue alors avec NoSuchFieldException (vu en test).
     */
    public static Object getCategory(Object keyBinding) {
        if (keyBinding == null) return null;
        String fieldName = MappingsRegistry.runtimeField(CLS_KEYBINDING, "f");
        Class<?> c = keyBinding.getClass();
        while (c != null) {
            try {
                Field f = c.getDeclaredField(fieldName);
                f.setAccessible(true);
                return f.get(keyBinding);
            } catch (NoSuchFieldException ignored) {
            } catch (Exception e) {
                LauncherLog.warn("[LauncherAgent-Keybind] getCategory: " + e);
                return null;
            }
            c = c.getSuperclass();
        }
        return null;
    }

    /**
     * KeyBinding.setBoundKey(InputUtil.Key) ("b", (Lfyc$a;)V) à partir d'un
     * code clavier GLFW brut (ex: GLFW_KEY_A=65) — construit la Key via
     * InputUtil$Type.KEYSYM.createFromCode(code) ("a" sur fyc$b, (I)Lfyc$a;).
     * N'appelle PAS updateKeysByCode() — à faire une fois après, voir
     * updateKeysByCode() (évite de le refaire à chaque binding lors d'un reset
     * global en boucle).
     */
    public static void setBoundKeyFromGlfwCode(Object keyBinding, int glfwCode, ClassLoader cl) {
        try {
            Class<?> typeClass = Class.forName(MappingsRegistry.runtimeClass(CLS_INPUT_TYPE), true, cl);
            String keysymFieldName = MappingsRegistry.runtimeField(CLS_INPUT_TYPE, "a"); // KEYSYM
            Field keysymField = typeClass.getDeclaredField(keysymFieldName);
            keysymField.setAccessible(true);
            Object keysym = keysymField.get(null);

            Set<String> createNames = MappingsRegistry.runtimeMethodNames(CLS_INPUT_TYPE, "a");
            Method createMethod = null;
            for (Method m : typeClass.getMethods()) {
                if (createNames.contains(m.getName()) && m.getParameterCount() == 1 && m.getParameterTypes()[0] == int.class) {
                    createMethod = m; break;
                }
            }
            if (createMethod == null) {
                LauncherLog.warn("[LauncherAgent-Keybind] setBoundKeyFromGlfwCode: createFromCode introuvable");
                return;
            }
            Object key = createMethod.invoke(keysym, glfwCode);

            String setName = MappingsRegistry.runtimeMethod(CLS_KEYBINDING, "b", "(Lfyc$a;)V");
            for (Method m : keyBinding.getClass().getMethods()) {
                if (m.getName().equals(setName) && m.getParameterCount() == 1) {
                    m.invoke(keyBinding, key);
                    return;
                }
            }
            LauncherLog.warn("[LauncherAgent-Keybind] setBoundKeyFromGlfwCode: setBoundKey introuvable (" + setName + ")");
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] setBoundKeyFromGlfwCode: " + e);
        }
    }

    /** KeyBinding.updateKeysByCode() ("e", static, ()V) — à appeler après toute modification de boundKey. */
    public static void updateKeysByCode(ClassLoader cl) {
        try {
            Class<?> kbClass = Class.forName(MappingsRegistry.runtimeClass(CLS_KEYBINDING), true, cl);
            Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_KEYBINDING, "e");
            for (Method m : kbClass.getDeclaredMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 0 && Modifier.isStatic(m.getModifiers())) {
                    m.setAccessible(true);
                    m.invoke(null);
                    return;
                }
            }
            LauncherLog.warn("[LauncherAgent-Keybind] updateKeysByCode: méthode introuvable parmi " + names);
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] updateKeysByCode: " + e);
        }
    }

    // ── Category ─────────────────────────────────────────────────────────────

    /**
     * KeyBinding$Category.id ("i", type Identifier) → représentation texte
     * stable (ex: "minecraft:movement") — utilisée comme clé de persistance
     * (KeybindSettings, catégories repliées).
     */
    public static String getCategoryId(Object category) {
        if (category == null) return null;
        String fieldName = MappingsRegistry.runtimeField(CLS_CATEGORY, "i");
        try {
            Field f = category.getClass().getDeclaredField(fieldName);
            f.setAccessible(true);
            Object identifier = f.get(category);
            return identifier == null ? null : identifier.toString();
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] getCategoryId: " + e);
            return null;
        }
    }

    /** KeyBinding$Category.getLabel() ("a", ()Lyh;) — Text localisé (vanilla : traduit ; mods : leur nom enregistré). */
    public static Object getCategoryLabel(Object category) {
        return invoke0(category, CLS_CATEGORY, "a");
    }

    /**
     * KeyBinding$Category.CATEGORIES ("j", static, List<Category>) — toutes
     * les catégories enregistrées (vanilla + mods). {@code cl} doit être le
     * classloader réel du jeu (ex: screen.getClass().getClassLoader()) — PAS
     * Thread.currentThread().getContextClassLoader(), pas fiable une fois le
     * jeu lancé.
     */
    @SuppressWarnings("unchecked")
    public static List<Object> getAllCategories(ClassLoader cl) {
        try {
            Class<?> categoryClass = Class.forName(MappingsRegistry.runtimeClass(CLS_CATEGORY), true, cl);
            String fieldName = MappingsRegistry.runtimeField(CLS_CATEGORY, "j");
            Field f = categoryClass.getDeclaredField(fieldName);
            f.setAccessible(true);
            Object v = f.get(null);
            if (v instanceof List<?>) return (List<Object>) v;
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] getAllCategories: " + e);
        }
        return List.of();
    }

    // ── Input (rebind listening) ─────────────────────────────────────────────

    /** InputUtil.isKeyPressed(Window, int) ("a" sur fyc, static, (Lfyk;I)Z) — état GLFW courant d'une touche. */
    public static boolean isWindowKeyPressed(Object window, int glfwCode, ClassLoader cl) {
        try {
            Class<?> inputUtilClass = Class.forName(MappingsRegistry.runtimeClass(CLS_INPUT_UTIL), true, cl);
            Set<String> names = MappingsRegistry.runtimeMethodNames(CLS_INPUT_UTIL, "a");
            for (Method m : inputUtilClass.getDeclaredMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 2 && Modifier.isStatic(m.getModifiers())
                        && m.getReturnType() == boolean.class) {
                    m.setAccessible(true);
                    return (boolean) m.invoke(null, window, glfwCode);
                }
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] isWindowKeyPressed: " + e);
        }
        return false;
    }

    // ── MinecraftClient / GameOptions ───────────────────────────────────────

    /** MinecraftClient.window ("O"). */
    public static Object getWindow(Object mc) {
        return ScreenHelper.getField(mc, CLS_MINECRAFT_CLIENT, "O");
    }

    /** MinecraftClient.options ("k"). */
    public static Object getOptions(Object mc) {
        return ScreenHelper.getField(mc, CLS_MINECRAFT_CLIENT, "k");
    }

    /** GameOptions.write() ("aQ", ()V) — persiste options.txt, comme vanilla après chaque changement de touche. */
    public static void writeOptions(Object options) {
        invoke0(options, CLS_GAME_OPTIONS, "aQ");
    }

    // ── Interne ──────────────────────────────────────────────────────────────

    /** Invoque une méthode 0-arg connue par son nom official, en remontant la hiérarchie si besoin. */
    private static Object invoke0(Object target, String officialOwner, String officialMethod) {
        if (target == null) return null;
        Set<String> names = MappingsRegistry.runtimeMethodNames(officialOwner, officialMethod);
        try {
            for (Method m : target.getClass().getMethods()) {
                if (names.contains(m.getName()) && m.getParameterCount() == 0) {
                    return m.invoke(target);
                }
            }
        } catch (Exception e) {
            LauncherLog.warn("[LauncherAgent-Keybind] invoke0(" + officialOwner + "." + officialMethod + "): " + e);
        }
        return null;
    }
}
