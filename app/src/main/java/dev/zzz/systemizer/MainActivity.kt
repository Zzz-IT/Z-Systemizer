package dev.zzz.systemizer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import top.yukonga.miuix.kmp.basic.*
import top.yukonga.miuix.kmp.theme.MiuixTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            val scope = rememberCoroutineScope()
            var apps by remember { mutableStateOf(listOf<String>()) }
            var systemized by remember { mutableStateOf(listOf<String>()) }
            var query by remember { mutableStateOf("") }
            var unlockedPkg by remember { mutableStateOf<String?>(null) }
            var log by remember { mutableStateOf("Ready") }

            fun systemizedPackageSet(): Set<String> {
                return systemized.mapNotNull { line ->
                    line.split(" ").firstOrNull()?.takeIf { it.isNotBlank() }
                }.toSet()
            }

            fun visiblePackages(): List<String> {
                val locked = systemizedPackageSet()
                val all = (apps + locked).distinct()
                val filtered = if (query.isBlank()) {
                    all
                } else {
                    all.filter { it.contains(query, ignoreCase = true) }
                }

                return filtered.sortedWith(
                    compareByDescending<String> { it in locked }.thenBy { it }
                )
            }

            fun refreshAll() {
                scope.launch {
                    log = "Loading..."

                    val userApps = withContext(Dispatchers.IO) {
                        SystemizerClient.listApps()
                    }.lines().filter { it.isNotBlank() }

                    val sysApps = withContext(Dispatchers.IO) {
                        SystemizerClient.listSystemized()
                    }.lines().filter { it.isNotBlank() }

                    apps = userApps
                    systemized = sysApps
                    unlockedPkg = null
                    log = "Loaded: ${userApps.size} user apps, ${sysApps.size} system/app"
                }
            }

            fun systemize(pkg: String) {
                scope.launch(Dispatchers.IO) {
                    val result = SystemizerClient.systemize(pkg, "app")
                    withContext(Dispatchers.Main) {
                        log = if (result.startsWith("ERROR") || result.contains("error=")) {
                            result
                        } else {
                            "Done: $pkg staged under system/app. Reboot required."
                        }
                        refreshAll()
                    }
                }
            }

            fun unsystemize(pkg: String) {
                scope.launch(Dispatchers.IO) {
                    val result = SystemizerClient.unsystemize(pkg)
                    withContext(Dispatchers.Main) {
                        log = if (result.startsWith("ERROR") || result.contains("error=")) {
                            result
                        } else {
                            "Done: $pkg removed from system/app. Reboot required."
                        }
                        unlockedPkg = null
                        refreshAll()
                    }
                }
            }

            MiuixTheme {
                Scaffold(
                    topBar = {
                        TopAppBar(title = "Z Systemizer")
                    }
                ) { padding ->
                    Column(
                        modifier = Modifier
                            .padding(padding)
                            .fillMaxSize()
                    ) {
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp)
                        ) {
                            Column(modifier = Modifier.padding(12.dp)) {
                                Text(text = log)

                                Spacer(Modifier.height(8.dp))

                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TextButton(
                                        text = "Refresh",
                                        onClick = { refreshAll() }
                                    )

                                    TextButton(
                                        text = "Clear Search",
                                        onClick = { query = "" }
                                    )
                                }
                            }
                        }

                        OutlinedTextField(
                            value = query,
                            onValueChange = { query = it },
                            label = { Text("Search package") },
                            singleLine = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 12.dp)
                        )

                        Spacer(Modifier.height(8.dp))

                        LazyColumn(
                            modifier = Modifier.fillMaxSize()
                        ) {
                            items(visiblePackages()) { pkg ->
                                val isSystemized = pkg in systemizedPackageSet()
                                val isUnlocked = unlockedPkg == pkg

                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 12.dp, vertical = 6.dp)
                                ) {
                                    Row(
                                        modifier = Modifier
                                            .padding(12.dp)
                                            .fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Column(
                                            modifier = Modifier.weight(1f)
                                        ) {
                                            Text(pkg)
                                            Text(if (isSystemized) "system/app locked" else "not processed")
                                        }

                                        if (isSystemized) {
                                            TextButton(
                                                text = if (isUnlocked) "Remove" else "Unlock",
                                                onClick = {
                                                    if (isUnlocked) {
                                                        unsystemize(pkg)
                                                    } else {
                                                        unlockedPkg = pkg
                                                        log = "Locked: tap Remove to confirm removing $pkg from system/app"
                                                    }
                                                }
                                            )
                                        } else {
                                            TextButton(
                                                text = "SYS",
                                                onClick = { systemize(pkg) }
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
