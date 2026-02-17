/**
 * Infrastructure Service
 * Manages local services needed for running tests (MongoDB, Redis, Kafka, Zookeeper)
 */

import { execSync } from 'child_process';
import { log, warn, err } from '../logger.js';

const SCRIPT_TIMEOUT = 2 * 60 * 1000; // 2 minutes

/**
 * Check if services are likely running
 */
export function checkServicesRunning() {
  try {
    // Check MongoDB (27017)
    execSync('lsof -i:27017', { stdio: 'pipe' });
    // Check Redis (6379)
    execSync('lsof -i:6379', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start infrastructure services (MongoDB, Redis, Zookeeper, Kafka)
 */
export async function startServices(config) {
  if (!config.INFRA_ENABLED) {
    log('Infrastructure management disabled, skipping');
    return true;
  }

  log('Starting infrastructure services...');

  if (checkServicesRunning()) {
    log('✓ Services already running');
    return true;
  }

  const startScript = `${config.INFRA_SCRIPTS_DIR}/run_services.sh`;

  try {
    execSync(`zsh "${startScript}"`, {
      cwd: config.INFRA_SCRIPTS_DIR,
      stdio: 'inherit',
      timeout: SCRIPT_TIMEOUT,
    });
    log('✓ Infrastructure services started');
    return true;
  } catch (error) {
    err(`Failed to start services: ${error.message}`);
    return false;
  }
}

/**
 * Stop infrastructure services
 */
export async function stopServices(config) {
  if (!config.INFRA_ENABLED || !config.INFRA_STOP_AFTER) {
    return true;
  }

  log('Stopping infrastructure services...');

  const stopScript = `${config.INFRA_SCRIPTS_DIR}/stop-services.sh`;

  try {
    execSync(`zsh "${stopScript}"`, {
      cwd: config.INFRA_SCRIPTS_DIR,
      stdio: 'inherit',
      timeout: SCRIPT_TIMEOUT,
    });
    log('✓ Infrastructure services stopped');
    return true;
  } catch (error) {
    warn(`Failed to stop services: ${error.message}`);
    return false;
  }
}

export default {
  checkServicesRunning,
  startServices,
  stopServices,
};
