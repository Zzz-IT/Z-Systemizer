package dev.zzz.systemizer

import java.io.BufferedReader
import java.io.InputStreamReader

object RootCommand {

    data class Result(
        val exitCode: Int,
        val output: String,
    ) {
        val ok: Boolean get() = exitCode == 0
        fun display(): String {
            return if (ok) {
                output.ifBlank { "OK" }
            } else {
                "ERROR($exitCode): ${output.ifBlank { "command failed" }}"
            }
        }
    }

    fun execResult(command: String): Result {
        return try {
            val proc = ProcessBuilder("su", "-c", command)
                .redirectErrorStream(true)
                .start()

            val output = BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                reader.readLines().joinToString("\n")
            }

            val exit = proc.waitFor()
            Result(exit, output.trim())
        } catch (e: Exception) {
            Result(-1, e.message ?: e.javaClass.simpleName)
        }
    }

    fun exec(command: String): String = execResult(command).display()

    fun isRootAvailable(): Boolean {
        return execResult("echo ok").ok
    }
}
