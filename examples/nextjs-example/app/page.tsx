export default function Home() {
  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h1>Next.js Fragno/Chatno Integration Test</h1>
      <p>API routes are mounted at: /api/chatno</p>
      <ul>
        <li>GET /api/chatno/ - Hello World</li>
        <li>GET /api/chatno/echo/:message - Echo stored message</li>
        <li>PUT /api/chatno/echo/:messageKey - Store a message</li>
        <li>GET /api/chatno/ai-config - Get AI config</li>
        <li>GET /api/chatno/thing/**:path - Wildcard route test</li>
      </ul>
    </div>
  );
}