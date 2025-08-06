# 07 · Roadmap

| Phase   | Target Date | Deliverables               |
| ------- | ----------- | -------------------------- |
| **MVP** | 2024-08     | • React + Express adapters |

• navigate / submitForm tools  
• OpenAI provider  
• Vite plugin alpha | | **Beta** | 2024-10 | • Vue/Nuxt & Hono adapters  
• Custom tool API  
• Context summariser v2  
• Basic telemetry dashboard | | **v1.0** | 2025-01 | • Stable API freeze  
• Docs & playground  
• Security audit  
• SOC-2 report | | **v1.1** | 2025-03 | • Llama / Ollama provider  
• Svelte adapter  
• Built-in analytics SDK | | **v2.0** | 2025-06 | • Multi-agent workflows  
• Offline background tasks  
• GUI tool builder |

## Risks & Mitigations

1. **LLM API pricing changes** → abstract providers early, support on-prem.
2. **Browser SSE limitations** → keep fallback (fetch+readable stream).
3. **Framework breaking changes** → maintain adapter test harness.

## Key Open Issues

- Decide on message persistence strategy (plugin vs core).
- Build storybook-like demo for docs site.
