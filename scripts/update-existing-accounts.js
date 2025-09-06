import bcrypt from "bcrypt";
import { pool } from "../db.js";

async function updateExistingAccounts() {
  try {
    console.log("🔄 Updating existing accounts with password hashes...");
    
    // Hash the test password
    const testPassword = "TestPassword123!";
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(testPassword, saltRounds);
    
    // Update the test account
    const result = await pool.query(`
      UPDATE accounts 
      SET password_hash = $1, updated_at = now()
      WHERE email = $2 AND password_hash IS NULL
      RETURNING email, name
    `, [passwordHash, "test@example.com"]);
    
    if (result.rows.length > 0) {
      console.log(`✅ Updated account: ${result.rows[0].email} (${result.rows[0].name})`);
    } else {
      console.log("ℹ️ No accounts needed updating or account not found");
    }
    
    // Check for other accounts without passwords
    const accountsWithoutPasswords = await pool.query(`
      SELECT email, name FROM accounts WHERE password_hash IS NULL
    `);
    
    if (accountsWithoutPasswords.rows.length > 0) {
      console.log("⚠️ Accounts without passwords:");
      accountsWithoutPasswords.rows.forEach(account => {
        console.log(`  - ${account.email} (${account.name})`);
      });
      console.log("These accounts will need password setup through support.");
    }
    
    console.log("✅ Account update completed");
    
  } catch (error) {
    console.error("❌ Error updating accounts:", error);
  } finally {
    process.exit(0);
  }
}

updateExistingAccounts();

