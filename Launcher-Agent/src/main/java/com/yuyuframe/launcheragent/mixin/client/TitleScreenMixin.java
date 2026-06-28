package com.yuyuframe.launcheragent.mixin.client;

import com.yuyuframe.launcheragent.runtime.fabric.FabricKnotExposer;
import com.yuyuframe.launcheragent.runtime.log.LauncherLog;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Mixin de fumée — confirme que le pipeline Mixin standalone de LauncherAgent
 * s'initialise correctement (mappings Yarn + transformer + retransform),
 * indépendamment du p2p-agent. Ne touche à rien d'autre.
 *
 * À remplacer par le mixin réel sur l'écran resource packs une fois
 * l'écran custom et content_core.dll posés (voir docs/LauncherAgent/index.md).
 */
@Mixin(targets = "net.minecraft.client.gui.screen.TitleScreen")
public abstract class TitleScreenMixin {

    @Inject(method = "bg_()V", at = @At("TAIL"))
    private void la$onInit(CallbackInfo ci) {
        FabricKnotExposer.ensureExposed(this.getClass().getClassLoader());
        LauncherLog.ui(3, "[LauncherAgent] Hook TitleScreen.init() OK — pipeline Mixin opérationnel");
    }
}
