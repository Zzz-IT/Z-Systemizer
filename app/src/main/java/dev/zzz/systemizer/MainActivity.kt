package dev.zzz.systemizer

import android.app.Activity
import android.os.Bundle
import android.widget.*

class MainActivity : Activity() {

    private lateinit var listView: ListView
    private lateinit var adapter: ArrayAdapter<String>
    private val apps = mutableListOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this)
        layout.orientation = LinearLayout.VERTICAL

        val button = Button(this)
        button.text = "Refresh Apps"

        listView = ListView(this)
        adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, apps)
        listView.adapter = adapter

        button.setOnClickListener {
            loadApps()
        }

        layout.addView(button)
        layout.addView(listView)

        setContentView(layout)
    }

    private fun loadApps() {
        apps.clear()

        val pm = packageManager
        val list = pm.getInstalledApplications(0)

        for (app in list) {
            apps.add(app.packageName)
        }

        adapter.notifyDataSetChanged()
    }
}
