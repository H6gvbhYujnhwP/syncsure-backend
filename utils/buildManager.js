/**
 * SyncSure V9 Build Manager
 * Handles agent build lifecycle and GitHub Actions integration
 */

const fetch = require('node-fetch');
const { pool } = require('../config/database');

/**
 * Ensure build exists for license
 * Triggers build if missing or outdated
 * @param {number} licenseId - License ID
 * @param {number} accountId - Account ID
 * @returns {Object} - Build status
 */
async function ensureBuildForLicense(licenseId, accountId) {
  try {
    // Check if build already exists and is recent
    const existingBuild = await pool.query(`
      SELECT * FROM builds 
      WHERE license_id = $1 
      ORDER BY created_at DESC 
      LIMIT 1
    `, [licenseId]);
    
    // If build exists and has all required assets, return it
    if (existingBuild.rows.length > 0) {
      const build = existingBuild.rows[0];
      
      // Check if build has all required assets
      if (build.status === 'completed' && 
          build.exe_url && 
          build.hash_url && 
          build.script_url) {
        return {
          status: 'exists',
          build: build
        };
      }
    }
    
    // Get license key for build
    const licenseResult = await pool.query(
      'SELECT license_key FROM licenses WHERE id = $1',
      [licenseId]
    );
    
    if (licenseResult.rows.length === 0) {
      throw new Error('License not found');
    }
    
    const licenseKey = licenseResult.rows[0].license_key;
    
    // Create build record
    const buildResult = await pool.query(`
      INSERT INTO builds (
        license_id, account_id, license_key, status, created_at, updated_at
      ) VALUES ($1, $2, $3, 'pending', NOW(), NOW())
      RETURNING *
    `, [licenseId, accountId, licenseKey]);
    
    const build = buildResult.rows[0];
    
    // Trigger GitHub Actions build
    const triggerResult = await triggerGitHubBuild(licenseKey, build.id);
    
    if (triggerResult.success) {
      // Update build status
      await pool.query(`
        UPDATE builds 
        SET status = 'building', github_run_id = $1, updated_at = NOW()
        WHERE id = $2
      `, [triggerResult.runId, build.id]);
      
      return {
        status: 'triggered',
        build: { ...build, status: 'building', github_run_id: triggerResult.runId }
      };
    } else {
      // Update build status to failed
      await pool.query(`
        UPDATE builds 
        SET status = 'failed', error_message = $1, updated_at = NOW()
        WHERE id = $2
      `, [triggerResult.error, build.id]);
      
      return {
        status: 'failed',
        error: triggerResult.error,
        build: build
      };
    }
  } catch (error) {
    console.error('Error ensuring build for license:', error);
    throw error;
  }
}

/**
 * Trigger GitHub Actions build
 * @param {string} licenseKey - License key to embed in build
 * @param {number} buildId - Build ID for tracking
 * @returns {Object} - {success: boolean, runId?: string, error?: string}
 */
async function triggerGitHubBuild(licenseKey, buildId) {
  try {
    const githubOwner = process.env.GITHUB_OWNER;
    const githubRepo = process.env.GITHUB_REPO;
    const githubPat = process.env.GITHUB_PAT;
    const workflowFile = process.env.GITHUB_WORKFLOW_FILE || 'build.yml';
    
    if (!githubOwner || !githubRepo || !githubPat) {
      throw new Error('GitHub configuration missing');
    }
    
    const url = `https://api.github.com/repos/${githubOwner}/${githubRepo}/actions/workflows/${workflowFile}/dispatches`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `token ${githubPat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'SyncSure-Backend'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          license_key: licenseKey,
          build_id: buildId.toString()
        }
      })
    });
    
    if (response.ok) {
      // GitHub doesn't return run ID immediately, we'll track it via webhook
      console.log(`GitHub Actions build triggered for license: ${licenseKey}`);
      return {
        success: true,
        runId: null // Will be updated via webhook
      };
    } else {
      const errorText = await response.text();
      console.error('GitHub Actions trigger failed:', response.status, errorText);
      return {
        success: false,
        error: `GitHub API error: ${response.status} - ${errorText}`
      };
    }
  } catch (error) {
    console.error('Error triggering GitHub build:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Update build with completed assets
 * Called when GitHub Actions completes and uploads assets
 * @param {number} buildId - Build ID
 * @param {Object} assets - {exeUrl, hashUrl, scriptUrl}
 * @returns {Object} - Updated build
 */
async function updateBuildAssets(buildId, assets) {
  try {
    const result = await pool.query(`
      UPDATE builds 
      SET 
        status = 'completed',
        exe_url = $1,
        hash_url = $2,
        script_url = $3,
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $4
      RETURNING *
    `, [assets.exeUrl, assets.hashUrl, assets.scriptUrl, buildId]);
    
    if (result.rows.length === 0) {
      throw new Error('Build not found');
    }
    
    console.log(`Build ${buildId} completed with assets`);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating build assets:', error);
    throw error;
  }
}

/**
 * Mark build as failed
 * @param {number} buildId - Build ID
 * @param {string} errorMessage - Error message
 * @returns {Object} - Updated build
 */
async function markBuildFailed(buildId, errorMessage) {
  try {
    const result = await pool.query(`
      UPDATE builds 
      SET 
        status = 'failed',
        error_message = $1,
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [errorMessage, buildId]);
    
    if (result.rows.length === 0) {
      throw new Error('Build not found');
    }
    
    console.log(`Build ${buildId} marked as failed: ${errorMessage}`);
    return result.rows[0];
  } catch (error) {
    console.error('Error marking build as failed:', error);
    throw error;
  }
}

/**
 * Get latest build for license
 * @param {number} licenseId - License ID
 * @returns {Object|null} - Latest build or null
 */
async function getLatestBuildForLicense(licenseId) {
  try {
    const result = await pool.query(`
      SELECT * FROM builds 
      WHERE license_id = $1 
      ORDER BY created_at DESC 
      LIMIT 1
    `, [licenseId]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error getting latest build:', error);
    throw error;
  }
}

/**
 * Get download links for license
 * @param {number} licenseId - License ID
 * @returns {Object|null} - Download links or null
 */
async function getDownloadLinksForLicense(licenseId) {
  try {
    const build = await getLatestBuildForLicense(licenseId);
    
    if (!build || build.status !== 'completed') {
      return null;
    }
    
    return {
      exe: {
        url: build.exe_url,
        name: 'SyncSure-Agent.exe'
      },
      hash: {
        url: build.hash_url,
        name: 'SyncSure-Agent.exe.sha256'
      },
      script: {
        url: build.script_url,
        name: 'Install-SyncSure.ps1'
      },
      buildDate: build.completed_at,
      version: build.version || '1.0.0'
    };
  } catch (error) {
    console.error('Error getting download links:', error);
    throw error;
  }
}

/**
 * Check if build is needed for license
 * @param {number} licenseId - License ID
 * @returns {boolean} - Whether build is needed
 */
async function isBuildNeeded(licenseId) {
  try {
    const build = await getLatestBuildForLicense(licenseId);
    
    // No build exists
    if (!build) return true;
    
    // Build failed
    if (build.status === 'failed') return true;
    
    // Build is pending or building (don't trigger another)
    if (['pending', 'building'].includes(build.status)) return false;
    
    // Build completed but missing assets
    if (build.status === 'completed' && 
        (!build.exe_url || !build.hash_url || !build.script_url)) {
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking if build is needed:', error);
    return true; // Default to needing build on error
  }
}

module.exports = {
  ensureBuildForLicense,
  triggerGitHubBuild,
  updateBuildAssets,
  markBuildFailed,
  getLatestBuildForLicense,
  getDownloadLinksForLicense,
  isBuildNeeded
};

