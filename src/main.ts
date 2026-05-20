import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { vTooltip } from './tooltip'

createApp(App).directive('tooltip', vTooltip).mount('#app')
