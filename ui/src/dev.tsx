/**
 * Development-only entry for `ui/index.html`.
 *
 * The published bundle mounts itself through the host's module loader; this
 * harness simply renders the same page into a plain browser so the settings view
 * can be developed against a running DSH host (same-origin `/cherry-remote/api`).
 * It is NOT part of the published artifact.
 */
import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const target = document.getElementById('root')
if (target === null) throw new Error('dev harness: #root is missing')

createRoot(target).render(createElement(StrictMode, null, createElement(App)))
