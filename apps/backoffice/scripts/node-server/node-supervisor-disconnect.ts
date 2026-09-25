type NodeBackofficeShutdown = () => Promise<void>;

/** Gracefully stops a supervised Node Backoffice service if its process supervisor disappears. */
export function stopNodeBackofficeOnSupervisorDisconnect(
  serviceName: string,
  shutdown: NodeBackofficeShutdown,
): void {
  if (!process.connected) {
    return;
  }

  process.once("disconnect", () => {
    void shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(
          `Node Backoffice ${serviceName} supervisor disconnect shutdown failed`,
          error,
        );
        process.exit(1);
      },
    );
  });
}
