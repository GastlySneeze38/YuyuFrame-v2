package com.yuyuframe.launcheragent.mixin.client;

import com.yuyuframe.launcheragent.runtime.fabric.FabricKnotExposer;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import com.yuyuframe.launcheragent.runtime.screen.ScreenHelper;
import com.yuyuframe.launcheragent.screen.CustomKeybindsScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Remplace l'écran Controls vanilla par CustomKeybindsScreen, en entier —
 * tenter d'AUGMENTER l'écran vanilla par réflexion (chips, en-têtes
 * mutés, etc.) s'est avéré trop fragile : positions internes pas fiables à
 * lire/écrire, et mixer dans EntryListWidget (classe partagée par d'autres
 * mods comme YACL) a cassé leur propre mixin lors du retransform — voir
 * historique. Un écran maison (déjà le pattern de ResourcePackSearchScreen)
 * donne un contrôle total sur le rendu et les clics.
 *
 * Injecté en TAIL du CONSTRUCTEUR : à ce stade {@code this} est entièrement
 * construit mais PAS ENCORE affiché — MinecraftClient.setScreen(...) (qui a
 * créé cette instance) n'a pas encore assigné currentScreen = this, donc
 * mc.currentScreen vaut encore l'écran qui a OUVERT KeybindsScreen (ex:
 * OptionsScreen) : exactement le "parent" dont on a besoin pour le bouton
 * Retour de notre écran, sans avoir à capturer un paramètre typé Screen/
 * GameOptions dans le handler (Mixin exige une correspondance de type EXACTE
 * pour tout paramètre capturé, et on n'a pas de stub compilable pour le nom
 * obfusqué réel de Screen ici).
 */
@Mixin(targets = "net.minecraft.client.gui.screen.option.KeybindsScreen")
public abstract class KeybindsScreenMixin {

    @Inject(method = "<init>(Lgsb;Lgfo;)V", at = @At("TAIL"))
    private void la$onInit(CallbackInfo ci) {
        try {
            FabricKnotExposer.ensureExposed(this.getClass().getClassLoader());

            Object mc = ScreenHelper.getMc(this);
            Object parentScreen = readCurrentScreen(mc);

            LauncherLog.ui(3, "[LauncherAgent] KeybindsScreenMixin: remplacement par CustomKeybindsScreen (parent="
                + parentScreen + ")");
            ScreenHelper.navigate(this, new CustomKeybindsScreen(parentScreen));
        } catch (Throwable t) {
            LauncherLog.err("[LauncherAgent] KeybindsScreenMixin onInit: " + t);
            t.printStackTrace(System.err);
        }
    }

    private static Object readCurrentScreen(Object mc) {
        if (mc == null) return null;
        return ScreenHelper.getField(mc, "gfj", "x");
    }
}
