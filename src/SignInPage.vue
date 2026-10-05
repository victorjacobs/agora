<script setup lang="ts">
import { computed } from 'vue'
import type { Connection } from './hermes/types'

const props = defineProps<{
  loginUrl: string
  endpoint: string
  connection: Connection
  error: string
}>()
defineEmits<{ retry: [] }>()

const server = computed(() => props.endpoint || window.location.origin)
const checking = computed(() => props.connection === 'connecting')
const connectionError = computed(() => props.connection !== 'expired' ? props.error : '')
</script>

<template>
  <main class="sign-in-page" aria-labelledby="sign-in-title">
    <header class="sign-in-brand"><span class="brand-mark" aria-hidden="true">a</span><span>agora</span></header>

    <section class="sign-in-content">
      <h1 id="sign-in-title">Sign in to Agora</h1>

      <div class="sign-in-card">
        <div class="sign-in-server">
          <span class="server-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4" stroke-linecap="round" /></svg>
          </span>
          <div><p class="server-label">HERMES SERVER</p><p class="server-address">{{ server }}</p></div>
        </div>

        <div v-if="connectionError" class="sign-in-error" role="alert">
          <p>{{ connectionError }}</p>
          <button v-if="connection === 'failed'" class="text-button" @click="$emit('retry')">Try connecting again</button>
        </div>

        <a class="button primary sign-in-button" :href="loginUrl"><span>Sign in with Hermes</span><span aria-hidden="true">→</span></a>
      </div>

      <p class="sign-in-status" role="status">
        <template v-if="checking"><span class="pulse" aria-hidden="true"></span>Checking connection…</template>
        <template v-else-if="connection === 'expired'">Sign-in required.</template>
        <template v-else-if="connection === 'reconnecting'">Retrying the connection…</template>
      </p>
    </section>
  </main>
</template>

<style scoped>
.sign-in-page { min-height: 100dvh; padding: 32px clamp(20px, 5vw, 64px) 24px; align-items: center; background: radial-gradient(ellipse at 50% 45%, var(--glow), transparent 65%), var(--page); }
.sign-in-brand { align-self: flex-start; display: flex; align-items: center; gap: 11px; font: 30px Georgia, serif; letter-spacing: -1px; }
.sign-in-brand .brand-mark { width: 34px; height: 34px; border-radius: 10px; font-size: 30px; }
.sign-in-content { width: 100%; max-width: 440px; text-align: center; margin: auto 0; padding: 48px 0 28px; }
.sign-in-content h1 { font: clamp(34px, 6vw, 44px)/1.15 Georgia, serif; letter-spacing: -1px; white-space: normal; color: var(--heading); margin: 0; }
.sign-in-card { margin-top: 28px; text-align: left; padding: 24px; border: 1px solid var(--selected-border); border-radius: 18px; background: var(--surface); box-shadow: 0 12px 36px var(--shadow); }
.sign-in-server { display: flex; align-items: center; gap: 13px; margin-bottom: 24px; }
.sign-in-server > div { min-width: 0; }
.server-icon { display: grid; place-items: center; width: 42px; height: 42px; flex-shrink: 0; background: var(--panel); border: 1px solid var(--border); color: var(--avatar-text); border-radius: 12px; }
.server-icon svg { width: 23px; height: 23px; }
.server-label { margin: 0 0 3px; font-size: 9px; letter-spacing: 1.5px; color: var(--muted); }
.server-address { margin: 0; font-size: 13px; font-weight: 550; color: var(--heading); overflow-wrap: anywhere; }
.sign-in-button { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 14px 18px; border-radius: 10px; font-size: 15px; font-weight: 600; }
.sign-in-button > :last-child { font-size: 21px; line-height: 1; font-weight: normal; }
.sign-in-button:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
.sign-in-status { min-height: 20px; display: flex; align-items: center; justify-content: center; gap: 8px; margin: 20px 0 0; font-size: 12px; color: var(--muted); }
.sign-in-error { padding: 12px 14px; margin: 0 0 18px; border: 1px solid var(--warning-border); border-radius: 9px; background: var(--warning); color: var(--warning-text); font-size: 12px; overflow-wrap: anywhere; }
.sign-in-error p { margin: 0; }
.sign-in-error button { color: inherit; margin: 6px 0 0; padding: 0; text-decoration: underline; text-underline-offset: 3px; }
@media (max-width: 480px) { .sign-in-page { padding-top: 24px; } .sign-in-content { padding-top: 36px; } .sign-in-card { padding: 20px; } }
@media (max-height: 700px) { .sign-in-page { padding-top: 20px; padding-bottom: 20px; } .sign-in-content { padding-top: 24px; padding-bottom: 16px; } .sign-in-server { margin-bottom: 18px; } .sign-in-status { margin-top: 14px; } }
</style>
