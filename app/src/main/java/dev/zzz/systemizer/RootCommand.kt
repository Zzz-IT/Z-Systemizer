package dev.zzz.systemizer

import java.io.BufferedReader
import java.io.InputStreamReader

object RootCommand {

    data class Result(
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
    ) {
        val ok: Boolean get() = exitCode == 0
        fun display(): String {
            val body = listOf(stdout, stderr).filter { it.isNotBlank() }.joinToString("\n")
            return if (ok) body.ifBlank { "OK" } else "ERROR($exitCode): $body"
        }
    }

    fun execResult(command: String): Result {
        return try {
            val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", command))

            val stdout = BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                reader.readLines().joinToString("\n")
            }

            val stderr = BufferedReader(InputStreamReader(proc.errorStream)).use { reader ->
                reader.readLines().joinToString("\n")
            }

            val exit = proc.waitFor()
            Result(exit, stdout.trim(), stderr.trim())
        } catch (e: Exception) {
            Result(-1, "", e.message ?: e.javaClass.simpleName)
        }
    }

    fun exec(command: String): String = execResult(command).display()

    fun isRootAvailable(): Boolean {
        return execResult("echo ok").ok
    }
}
