package com.yuyuframe.launcheragent.mixin.service;

import org.spongepowered.asm.service.IMixinServiceBootstrap;

/** Bootstrap du service Mixin LauncherAgent — enregistré via ServiceLoader. */
public class LauncherMixinServiceBootstrap implements IMixinServiceBootstrap {

    @Override
    public String getName() { return "LauncherJavaAgent"; }

    @Override
    public String getServiceClassName() {
        return "com.yuyuframe.launcheragent.mixin.service.LauncherMixinService";
    }

    @Override
    public void bootstrap() {}
}
