import { PostHog } from "posthog-node";

import { TKeyStoreFactory } from "@app/keystore/keystore";
import { getConfig } from "@app/lib/config/env";
import { logger } from "@app/lib/logger";
import { QueueJobs, QueueName, TQueueServiceFactory } from "@app/queue";

import { getServerCfg } from "../super-admin/super-admin-service";
import { TTelemetryDALFactory } from "./telemetry-dal";
import { TELEMETRY_SECRET_OPERATONS_KEY, TELEMETRY_SECRET_PROCESSED_KEY } from "./telemetry-service";
import { PostHogEventTypes } from "./telemetry-types";

type TTelemetryQueueServiceFactoryDep = {
  queueService: TQueueServiceFactory;
  keyStore: Pick<TKeyStoreFactory, "getItem" | "deleteItem">;
  telemetryDAL: TTelemetryDALFactory;
};

export type TTelemetryQueueServiceFactory = ReturnType<typeof telemetryQueueServiceFactory>;

export const telemetryQueueServiceFactory = ({
  queueService,
  keyStore,
  telemetryDAL
}: TTelemetryQueueServiceFactoryDep) => {
  const appCfg = getConfig();
  const postHog =
    appCfg.isProductionMode && appCfg.TELEMETRY_ENABLED
      ? new PostHog(appCfg.POSTHOG_PROJECT_API_KEY, { host: appCfg.POSTHOG_HOST })
      : undefined;

  queueService.start(QueueName.TelemetryInstanceStats, async () => {
    const { instanceId } = await getServerCfg();
    const telemtryStats = await telemetryDAL.getTelemetryInstanceStats();
    // parse the redis values into integer
    const numberOfSecretOperations = parseInt((await keyStore.getItem(TELEMETRY_SECRET_OPERATONS_KEY)) || "0", 10);
    const numberOfSecretProcessed = parseInt((await keyStore.getItem(TELEMETRY_SECRET_PROCESSED_KEY)) || "0", 10);
    const stats = { ...telemtryStats, numberOfSecretProcessed, numberOfSecretOperations };

    // send to postHog
    postHog?.capture({
      event: PostHogEventTypes.TelemetryInstanceStats,
      distinctId: instanceId,
      properties: stats
    });
    // reset the stats
    await keyStore.deleteItem(TELEMETRY_SECRET_PROCESSED_KEY);
    await keyStore.deleteItem(TELEMETRY_SECRET_OPERATONS_KEY);
  });

  // every day at midnight a telemetry job executes on self hosted
  // this sends some telemetry information like instance id secrets operated etc
  const startTelemetryCheck = async () => {
    // this is a fast way to check its cloud or not
    if (appCfg.LICENSE_SERVER_KEY) return;
    // clear previous job
    await queueService.stopRepeatableJob(
      QueueName.TelemetryInstanceStats,
      QueueJobs.TelemetryInstanceStats,
      { pattern: "0 0 * * *", utc: true },
      QueueName.TelemetryInstanceStats // just a job id
    );
    if (postHog) {
      await queueService.queue(QueueName.TelemetryInstanceStats, QueueJobs.TelemetryInstanceStats, undefined, {
        jobId: QueueName.TelemetryInstanceStats,
        repeat: { pattern: "0 0 * * *", utc: true }
      });
    }
  };

  queueService.listen(QueueName.TelemetryInstanceStats, "failed", (err) => {
    logger.error(err?.failedReason, `${QueueName.TelemetryInstanceStats}: failed`);
  });

  return {
    startTelemetryCheck
  };
};
