package com.yuyuframe.launcheragent.mixin.service;

import org.spongepowered.asm.logging.ILogger;
import org.spongepowered.asm.logging.Level;

/** Logger minimaliste pour Mixin — redirige vers System.out/err. */
public class LauncherLogger implements ILogger {

    private final String id;

    public LauncherLogger(String id) {
        this.id = id;
    }

    @Override public String getId()   { return id; }
    @Override public String getType() { return "System"; }

    @Override public void catching(Level lvl, Throwable t) { t.printStackTrace(System.err); }
    @Override public void catching(Throwable t)            { t.printStackTrace(System.err); }

    @Override public void debug(String msg, Object... args) { log(Level.DEBUG, msg, args); }
    @Override public void debug(String msg, Throwable t)    { log(Level.DEBUG, msg, t); }

    @Override public void info(String msg, Object... args) { log(Level.INFO, msg, args); }
    @Override public void info(String msg, Throwable t)    { log(Level.INFO, msg, t); }

    @Override public void warn(String msg, Object... args) { log(Level.WARN, msg, args); }
    @Override public void warn(String msg, Throwable t)    { log(Level.WARN, msg, t); }

    @Override public void error(String msg, Object... args) { log(Level.ERROR, msg, args); }
    @Override public void error(String msg, Throwable t)    { log(Level.ERROR, msg, t); }

    @Override public void fatal(String msg, Object... args) { log(Level.FATAL, msg, args); }
    @Override public void fatal(String msg, Throwable t)    { log(Level.FATAL, msg, t); }

    @Override public void trace(String msg, Object... args) {}
    @Override public void trace(String msg, Throwable t)    {}

    @Override
    public void log(Level lvl, String msg, Object... args) {
        String formatted = args.length == 0 ? msg : String.format(msg.replace("{}", "%s"), (Object[]) args);
        java.io.PrintStream out = (lvl.ordinal() >= Level.WARN.ordinal()) ? System.err : System.out;
        out.println("[Mixin/" + lvl + "] [" + id + "] " + formatted);
    }

    @Override
    public void log(Level lvl, String msg, Throwable t) {
        log(lvl, msg);
        t.printStackTrace(System.err);
    }

    @Override
    public <T extends Throwable> T throwing(T t) {
        t.printStackTrace(System.err);
        return t;
    }
}
