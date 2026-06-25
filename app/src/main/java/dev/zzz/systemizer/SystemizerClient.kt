package dev.zzz.systemizer

object SystemizerClient {

    fun systemize(pkg: String, target: String): String {
        val cmd = "/data/adb/modules/ksu-systemizer/bin/systemizer systemize $pkg $target"
        return RootCommand.exec(cmd)
    }

    fun unsystemize(pkg: String): String {
        val cmd = "/data/adb/modules/ksu-systemizer/bin/systemizer unsystemize $pkg"
        return RootCommand.exec(cmd)
    }

    fun diagnose(): String {
        val cmd = "/data/adb/modules/ksu-systemizer/bin/systemizer diagnose"
        return RootCommand.exec(cmd)
    }

    fun listApps(): String {
        val cmd = "/data/adb/modules/ksu-systemizer/bin/systemizer list-user-apps"
        return RootCommand.exec(cmd)
    }
}
