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
            var log by remember { mutableStateOf("Ready") }

            fun refreshApps() {
                scope.launch {
                    log = "Loading..."
                    val result = withContext(Dispatchers.IO) {
                        SystemizerClient.listApps()
                    }
                    apps = result.lines().filter { it.isNotBlank() }
                    log = "Loaded ${apps.size} apps"
                }
            }

            MiuixTheme {
                Scaffold(
                    topBar = {
                        TopAppBar(
                            title = { Text("Z Systemizer") }
                        )
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
                                    text = "Refresh Apps",
                                    onClick = { refreshApps() }
                                )

                            }
                        }

                        LazyColumn(
                            modifier = Modifier.fillMaxSize()
                        ) {
                            items(apps) { pkg ->

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
                                        Text(text = pkg)

                                        Row {
                                            TextButton(
                                                text = "SYS",
                                                onClick = {
                                                    scope.launch {
                                                        log = SystemizerClient.systemize(pkg, "app")
                                                    }
                                                }
                                            )

                                            Spacer(Modifier.width(8.dp))

                                            TextButton(
                                                text = "UN",
                                                onClick = {
                                                    scope.launch {
                                                        log = SystemizerClient.unsystemize(pkg)
                                                    }
                                                }
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
