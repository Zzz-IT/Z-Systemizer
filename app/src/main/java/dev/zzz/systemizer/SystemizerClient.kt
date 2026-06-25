package dev.zzz.systemizer

object SystemizerClient {

    private const val CLI_PATH = "/data/adb/modules/ksu-systemizer/bin/systemizer"

    private fun sanitizePackageName(pkg: String): String {
        return pkg.replace(Regex("[^a-zA-Z0-9._]"), "")
    }

    private fun sanitizeTarget(target: String): String {
        return target.replace(Regex("[^a-z]"), "")
    }

    fun systemize(pkg: String, target: String): String {
        val safePkg = sanitizePackageName(pkg)
        val safeTarget = sanitizeTarget(target)
        if (safePkg.isEmpty() || safePkg.length > 255) {
            return "ERROR: invalid package name"
        }
        val cmd = "$CLI_PATH systemize $safePkg $safeTarget"
        return RootCommand.exec(cmd)
    }

    fun unsystemize(pkg: String): String {
        val safePkg = sanitizePackageName(pkg)
        if (safePkg.isEmpty() || safePkg.length > 255) {
            return "ERROR: invalid package name"
        }
        val cmd = "$CLI_PATH unsystemize $safePkg"
        return RootCommand.exec(cmd)
    }

    fun diagnose(): String {
        return RootCommand.exec("$CLI_PATH diagnose")
    }

    fun listApps(): String {
        return RootCommand.exec("$CLI_PATH list-user-apps")
    }

    fun listSystemized(): String {
        return RootCommand.exec("$CLI_PATH list-systemized")
    }
}
