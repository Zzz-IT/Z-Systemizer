package dev.zzz.systemizer

import java.io.BufferedReader
import java.io.InputStreamReader

object RootCommand {

    fun exec(command: String): String {
        return try {
            val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", command))
            val reader = BufferedReader(InputStreamReader(proc.inputStream))
            val output = StringBuilder()

            reader.forEachLine {
                output.append(it).append("\n")
            }

            proc.waitFor()
            output.toString().trim()
        } catch (e: Exception) {
            "ERROR: ${e.message}"
        }
    }

    fun isRootAvailable(): Boolean {
        return try {
            val proc = Runtime.getRuntime().exec("su -c echo ok")
            proc.waitFor()
            proc.exitValue() == 0
        } catch (e: Exception) {
            false
        }
    }
}
