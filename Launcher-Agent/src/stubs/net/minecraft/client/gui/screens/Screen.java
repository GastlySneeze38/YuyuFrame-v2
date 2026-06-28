package net.minecraft.client.gui.screens;

import net.minecraft.network.chat.Component;

/**
 * Stub compile-only — obfusqué en gsb dans client-mappings-1.21.11.
 * Constructeur réel confirmé par décompilation : {@code protected gsb(yh)}.
 *
 * IMPORTANT : ce stub n'est jamais utilisé tel quel par nos écrans custom au
 * runtime. ScreenStubPatcher (mixin/service/transformer) réécrit le bytecode
 * de ces classes au chargement pour remplacer toute référence à ce stub —
 * superclasse, descripteurs, checkcast — par les vraies classes obfusquées
 * (gsb, yh). Sans ce patch, un écran "extends Screen" (ce stub) ne serait
 * jamais assignable à MinecraftClient.setScreen(Screen) puisque ce stub n'a
 * aucune relation de type avec la vraie classe obfusquée.
 */
public abstract class Screen {
    /** width → o, height → p, font → q, minecraft → minecraft field */
    public int width;
    public int height;
    protected Screen() {}
    protected Screen(Component title) {}
}
