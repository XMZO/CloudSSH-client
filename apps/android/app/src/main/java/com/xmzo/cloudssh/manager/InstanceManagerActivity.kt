package com.xmzo.cloudssh.manager

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import com.xmzo.cloudssh.R
import com.xmzo.cloudssh.config.Instance
import com.xmzo.cloudssh.config.InstanceConfigException
import com.xmzo.cloudssh.config.InstanceRules
import com.xmzo.cloudssh.config.InstanceStore
import com.xmzo.cloudssh.web.ShellActivity
import com.xmzo.cloudssh.web.StorageTrimmer
import com.xmzo.cloudssh.web.SystemBars

/**
 * 实例管理：新增/编辑/删除 Worker 地址、设为默认、清除登录数据、测试连接。
 * 点按实例即在主界面打开（会先确认，切换会关闭当前会话）。
 */
class InstanceManagerActivity : Activity() {

    private lateinit var store: InstanceStore
    private lateinit var adapter: InstanceAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_manager)
        SystemBars.install(this, findViewById(R.id.manager_root))
        store = InstanceStore(this)
        adapter = InstanceAdapter()
        val list = findViewById<ListView>(R.id.instance_list)
        list.adapter = adapter
        list.setOnItemClickListener { _, _, position, _ -> openInShell(adapter.getItem(position)) }
        list.setOnItemLongClickListener { _, _, position, _ ->
            showActions(adapter.getItem(position))
            true
        }
        findViewById<Button>(R.id.add_button).setOnClickListener { showEditor(null) }
        findViewById<Button>(R.id.back_button).setOnClickListener { finish() }
        findViewById<Button>(R.id.clear_cache_button).setOnClickListener {
            ShellActivity.clearWebCache(this)
            updateStorage()
            Toast.makeText(this, R.string.cache_cleared, Toast.LENGTH_SHORT).show()
        }
        refresh()
    }

    override fun onResume() {
        super.onResume()
        updateStorage()
    }

    /** 统计放到后台线程：遍历 WebView 目录可能有几百个文件 */
    private fun updateStorage() {
        val label = findViewById<TextView>(R.id.storage_info)
        Thread {
            val cache = StorageTrimmer.cacheSize(this)
            val data = StorageTrimmer.dataSize(this)
            runOnUiThread {
                label.text = getString(
                    R.string.storage_info,
                    StorageTrimmer.format(cache),
                    StorageTrimmer.format(data),
                    StorageTrimmer.format(StorageTrimmer.CACHE_LIMIT_BYTES),
                )
            }
        }.start()
    }

    private fun refresh() {
        val snapshot = store.load()
        adapter.update(snapshot.instances, snapshot.defaultId)
    }

    private fun openInShell(instance: Instance) {
        startActivity(
            Intent(this, ShellActivity::class.java)
                .putExtra(ShellActivity.EXTRA_INSTANCE_ID, instance.id)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }

    private fun showActions(instance: Instance) {
        val actions = arrayOf(
            getString(R.string.action_open),
            getString(R.string.action_edit),
            getString(R.string.action_set_default),
            getString(R.string.action_clear_data),
            getString(R.string.action_delete),
        )
        AlertDialog.Builder(this)
            .setTitle(instance.name)
            .setItems(actions) { _, which ->
                when (which) {
                    0 -> openInShell(instance)
                    1 -> showEditor(instance)
                    2 -> {
                        store.setDefault(instance.id)
                        refresh()
                    }
                    3 -> confirmClear(instance)
                    4 -> confirmDelete(instance)
                }
            }
            .show()
    }

    private fun confirmClear(instance: Instance) {
        AlertDialog.Builder(this)
            .setTitle(R.string.action_clear_data)
            .setMessage(getString(R.string.clear_data_message, instance.name))
            .setPositiveButton(android.R.string.ok) { _, _ ->
                clearData(instance)
                Toast.makeText(this, R.string.clear_data_done, Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun confirmDelete(instance: Instance) {
        AlertDialog.Builder(this)
            .setTitle(R.string.action_delete)
            .setMessage(getString(R.string.delete_message, instance.name))
            .setPositiveButton(android.R.string.ok) { _, _ ->
                try {
                    store.remove(instance.id)
                    clearData(instance)
                    refresh()
                } catch (e: InstanceConfigException) {
                    Toast.makeText(this, e.message, Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** 清除登录状态与网页数据：支持多 Profile 时只清该实例的 Profile，否则只删该域名的 session 与存储 */
    private fun clearData(instance: Instance) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            val profile = ProfileStore.getInstance().getOrCreateProfile("instance-${instance.id}")
            profile.cookieManager.removeAllCookies(null)
            profile.cookieManager.flush()
            profile.webStorage.deleteAllData()
        } else {
            CookieManager.getInstance().setCookie(instance.baseUrl, "session=; Max-Age=0; Path=/; Secure; HttpOnly")
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteOrigin(instance.baseUrl)
        }
        clearedIds += instance.id
    }

    private fun showEditor(instance: Instance?) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_instance, null)
        val nameField = view.findViewById<EditText>(R.id.field_name)
        val urlField = view.findViewById<EditText>(R.id.field_url)
        val result = view.findViewById<TextView>(R.id.test_result)
        nameField.setText(instance?.name ?: "")
        urlField.setText(instance?.baseUrl ?: "")

        view.findViewById<Button>(R.id.test_button).setOnClickListener {
            val baseUrl = try {
                InstanceRules.normalizeWorkerUrl(urlField.text.toString())
            } catch (e: InstanceConfigException) {
                result.text = e.message
                return@setOnClickListener
            }
            result.text = getString(R.string.test_running)
            InstanceProbe.run(baseUrl) { probe -> result.text = describe(baseUrl, probe) }
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(if (instance == null) R.string.add_instance_title else R.string.edit_instance)
            .setView(view)
            .setPositiveButton(R.string.save, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    store.upsert(instance?.id, nameField.text.toString(), urlField.text.toString())
                    refresh()
                    dialog.dismiss()
                } catch (e: InstanceConfigException) {
                    result.text = e.message
                }
            }
        }
        dialog.show()
    }

    private fun describe(baseUrl: String, probe: InstanceProbe.Result): String {
        if (!probe.ok) return getString(R.string.test_failed, probe.error ?: "")
        val auth = when (probe.authMode) {
            "github" -> getString(R.string.auth_github)
            "password" -> getString(R.string.auth_password)
            else -> getString(R.string.auth_anonymous)
        }
        val lines = mutableListOf(
            getString(R.string.test_ok, probe.latencyMs, auth + if (probe.loginRequired) getString(R.string.auth_required) else ""),
        )
        probe.oauthRedirectUri?.let { redirect ->
            lines += getString(R.string.test_oauth, redirect)
            val callbackOrigin = Uri.parse(redirect).let { "${it.scheme}://${it.authority}" }
            if (callbackOrigin != baseUrl) lines += getString(R.string.test_oauth_mismatch, callbackOrigin)
        }
        return lines.joinToString("\n")
    }

    private inner class InstanceAdapter : BaseAdapter() {
        private var items: List<Instance> = emptyList()
        private var defaultId: String = ""

        fun update(instances: List<Instance>, defaultId: String) {
            items = instances
            this.defaultId = defaultId
            notifyDataSetChanged()
        }

        override fun getCount() = items.size
        override fun getItem(position: Int) = items[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(parent.context).inflate(R.layout.item_instance, parent, false)
            val instance = items[position]
            view.findViewById<TextView>(R.id.item_name).text =
                if (instance.id == defaultId) "${instance.name}  · ${getString(R.string.default_badge)}" else instance.name
            view.findViewById<TextView>(R.id.item_url).text = instance.baseUrl
            return view
        }
    }

    companion object {
        private val clearedIds = mutableSetOf<String>()

        /** 主界面回到前台时检查：当前实例的数据刚被清除则需要重新加载 */
        fun consumeClearedFlag(id: String): Boolean = clearedIds.remove(id)
    }
}
