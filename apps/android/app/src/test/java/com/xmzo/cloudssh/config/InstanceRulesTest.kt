package com.xmzo.cloudssh.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 与 packages/core/test/instance.test.ts 对齐的规则测试 */
class InstanceRulesTest {
    @Test
    fun normalizesToOrigin() {
        assertEquals("https://bash.al", InstanceRules.normalizeWorkerUrl("bash.al"))
        assertEquals("https://example.workers.dev", InstanceRules.normalizeWorkerUrl(" https://Example.Workers.dev/ "))
        assertEquals("https://example.com:8443", InstanceRules.normalizeWorkerUrl("https://example.com:8443"))
        assertEquals("http://10.0.2.2:8787", InstanceRules.normalizeWorkerUrl("http://10.0.2.2:8787"))
    }

    @Test
    fun rejectsInvalidAddresses() {
        for (bad in listOf("", "http://example.com", "https://example.com/app", "https://u:p@example.com", "ftp://x.com", "https://x.com/?a=1")) {
            try {
                InstanceRules.normalizeWorkerUrl(bad)
                throw AssertionError("应拒绝：$bad")
            } catch (e: InstanceConfigException) {
                // 预期
            }
        }
    }

    @Test
    fun createsUniqueIds() {
        assertEquals("my-server", InstanceRules.createId("My Server", emptyList()))
        assertEquals("my-server-2", InstanceRules.createId("My Server", listOf("my-server")))
        assertEquals("instance", InstanceRules.createId("生产环境", emptyList()))
        assertTrue(InstanceRules.isValidId("default"))
        assertFalse(InstanceRules.isValidId("Bad ID"))
    }

    @Test
    fun comparesOrigins() {
        assertTrue(InstanceRules.isSameOrigin("wss://bash.al/api/ssh?token=x", "https://bash.al"))
        assertTrue(InstanceRules.isSameOrigin("https://bash.al:443/", "https://bash.al"))
        assertFalse(InstanceRules.isSameOrigin("https://github.com/login", "https://bash.al"))
        assertFalse(InstanceRules.isSameOrigin("ws://bash.al/api/ssh", "https://bash.al"))
    }
}
