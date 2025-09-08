"use client";

import React from "react";

import { createExampleFragmentClient } from "@fragno-dev/example-fragment";
import { useFragno } from "@fragno-dev/core/react";

const exampleFragmentClient = createExampleFragmentClient();
const { useData, useHash } = useFragno(exampleFragmentClient);

export default function Home() {
  const { data: currentData, loading: dataLoading } = useData(undefined, {
    name: "this-is-unused",
  });
  const { data: hashData, loading: hashLoading } = useHash();

  return (
    <div style={{ padding: "20px", fontFamily: "monospace", maxWidth: "800px", margin: "0 auto" }}>
      <h1>Next.js Fragno Example Fragment</h1>
      <p>Simple data reading with example-fragment</p>

      {!hashLoading && (
        <div style={{ marginBottom: "30px" }}>
          <p>{hashData}</p>
        </div>
      )}

      <div style={{ marginBottom: "30px" }}>
        <h2>Current Data</h2>
        {dataLoading ? (
          <p>Loading…</p>
        ) : (
          <div
            style={{
              padding: "15px",
              backgroundColor: "#f5f5f5",
              borderRadius: "5px",
              border: "1px solid #ddd",
            }}
          >
            {currentData || "No data yet"}
          </div>
        )}
      </div>

      <div style={{ marginTop: "30px", fontSize: "14px", color: "#666" }}>
        <h3>Available Endpoints:</h3>
        <ul>
          <li>GET /api/example-fragment/ - Hello World</li>
          <li>GET /api/example-fragment/data - Retrieve current data</li>
        </ul>
      </div>
    </div>
  );
}
