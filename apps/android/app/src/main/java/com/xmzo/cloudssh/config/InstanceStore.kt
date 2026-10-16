package com.xmzo.cloudssh.config

import android.content.Context
import com.xmzo.cloudssh.BuildConfig
import org.json.JSONArray
import org.json.JSONObject

/**
 * 连接与配置层：实例列表与默认实例，持久化在 SharedPreferences（JSON）。
 * 首次运行写入默认实例（BuildConfig.DEFAULT_WORKER_URL）。
 */
class InstanceStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("instances", Context.MODE_PRIVATE)

    data class Snapshot(val instances: List<Instance>, val defaultId: String, val lastId: String?)

    fun load(): Snapshot {
        val parsed = mutableListOf<Instance>()
        val raw = prefs.getString(KEY_INSTANCES, null)
        if (raw != null) {
            try {
                val array = JSONArray(raw)
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i) ?: continue
                    val id = item.optString("id")
                    if (!InstanceRules.isValidId(id) || parsed.any { it.id == id }) continue
                    val baseUrl = try {
                        InstanceRules.normalizeWorkerUrl(item.optString("baseUrl"))
                    } catch (e: InstanceConfigException) {
                        continue
                    }
                    parsed += Instance(id, item.optString("name").ifBlank { id }.take(64), baseUrl)
                }
            } catch (e: Exception) {
                // 损坏的配置按首次运行处理
            }
        }
        if (parsed.isEmpty()) {
            parsed += Instance(DEFAULT_ID, "CloudSSH", BuildConfig.DEFAULT_WORKER_URL)
            save(parsed, DEFAULT_ID)
        }
        val defaultId = prefs.getString(KEY_DEFAULT, null)?.takeIf { id -> parsed.any { it.id == id } } ?: parsed[0].id
        val lastId = prefs.getString(KEY_LAST, null)?.takeIf { id -> parsed.any { it.id == id } }
        return Snapshot(parsed, defaultId, lastId)
    }

    fun get(id: String): Instance? = load().instances.firstOrNull { it.id == id }

    /** 新增或更新（按 id 匹配）；id 为空时按名称生成 */
    fun upsert(id: String?, name: String, baseUrlInput: String): Instance {
        val snapshot = load()
        val baseUrl = InstanceRules.normalizeWorkerUrl(baseUrlInput)
        val finalId = id?.takeIf { existing -> snapshot.instances.any { it.id == existing } }
            ?: InstanceRules.createId(name.ifBlank { java.net.URI(baseUrl).host }, snapshot.instances.map { it.id })
        val instance = Instance(finalId, name.trim().ifBlank { finalId }.take(64), baseUrl)
        val next = snapshot.instances.toMutableList()
        val index = next.indexOfFirst { it.id == finalId }
        if (index >= 0) next[index] = instance else next += instance
        save(next, snapshot.defaultId)
        return instance
    }

    fun remove(id: String) {
        val snapshot = load()
        if (snapshot.instances.size <= 1) throw InstanceConfigException("至少需要保留一个实例")
        val next = snapshot.instances.filterNot { it.id == id }
        save(next, if (snapshot.defaultId == id) next[0].id else snapshot.defaultId)
        if (snapshot.lastId == id) prefs.edit().remove(KEY_LAST).apply()
    }

    fun setDefault(id: String) {
        prefs.edit().putString(KEY_DEFAULT, id).apply()
    }

    fun setLast(id: String) {
        prefs.edit().putString(KEY_LAST, id).apply()
    }

    private fun save(instances: List<Instance>, defaultId: String) {
        val array = JSONArray()
        for (instance in instances) {
            array.put(JSONObject().put("id", instance.id).put("name", instance.name).put("baseUrl", instance.baseUrl))
        }
        prefs.edit().putString(KEY_INSTANCES, array.toString()).putString(KEY_DEFAULT, defaultId).apply()
    }

    companion object {
        const val DEFAULT_ID = "default"
        private const val KEY_INSTANCES = "instances"
        private const val KEY_DEFAULT = "default_id"
        private const val KEY_LAST = "last_id"
    }
}
