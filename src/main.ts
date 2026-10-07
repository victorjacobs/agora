import { createApp } from 'vue'
import App from './App.vue'
import { disablePinchZoom } from './pinch-zoom'
import './theme.css'
import './style.css'

const restorePinchZoom = disablePinchZoom(document)
if (import.meta.hot) import.meta.hot.dispose(restorePinchZoom)

createApp(App).mount('#app')
