package dev.zzz.systemizer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
            var log by remember { mutableStateOf("Ready") }

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
                    log = "User:${apps.size} Systemized:${systemized.size}"
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

                                TextButton(
                                    text = "Refresh",
                                    onClick = { refreshAll() }
                                )
                            }
                        }

                        Text("User Apps")

                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                        ) {
                            items(apps) { pkg ->
                                Card(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(8.dp)
                                ) {
                                    Row(
                                        modifier = Modifier
                                            .padding(12.dp)
                                            .fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Text(pkg)

                                        TextButton(
                                            text = "SYS",
                                            onClick = {
                                                scope.launch {
                                                    log = SystemizerClient.systemize(pkg, "app")
                                                }
                                            }
                                        )
                                    }
                                }
                            }
                        }

                        Text("Systemized")

                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                        ) {
                            items(systemized) { line ->
                                Text(text = line, modifier = Modifier.padding(8.dp))
                            }
                        }
                    }
                }
            }
        }
    }
}
