const { Pool } = require('pg');

// เชื่อมต่อ Neon DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event, context) => {
  const method = event.httpMethod;

  try {
    // [GET] ดึงข้อมูลโมเดลทั้งหมด
    if (method === 'GET') {
      try {
        const result = await pool.query('SELECT * FROM api_models ORDER BY id ASC');
        return { statusCode: 200, body: JSON.stringify(result.rows) };
      } catch (err) {
        // ตรวจสอบรหัส 42703 (undefined_column) หรือข้อความที่เกี่ยวข้อง
        if (err.code === '42703' || err.message.includes('base_url')) {
          console.log('Migrating: Adding base_url column...');
          await pool.query('ALTER TABLE api_models ADD COLUMN base_url TEXT').catch(() => {});
          const result = await pool.query('SELECT * FROM api_models ORDER BY id ASC');
          return { statusCode: 200, body: JSON.stringify(result.rows) };
        }
        throw err;
      }
    }

    // [POST] บันทึกโมเดลใหม่ลง DB
    if (method === 'POST') {
      const body = JSON.parse(event.body);
      const model_id = 'm_' + Date.now();
      const query = 'INSERT INTO api_models (model_id, name, provider, api_key, model_type, base_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
      const values = [model_id, body.name, body.provider, body.key, body.type, body.base_url || null];

      try {
        const result = await pool.query(query, values);
        return { statusCode: 201, body: JSON.stringify(result.rows[0]) };
      } catch (err) {
        // ตรวจสอบรหัส 42703 (undefined_column) หรือข้อความที่เกี่ยวข้อง
        if (err.code === '42703' || err.message.includes('base_url')) {
          console.log('Migrating: Adding base_url column during POST...');
          await pool.query('ALTER TABLE api_models ADD COLUMN base_url TEXT').catch(() => {});
          const result = await pool.query(query, values);
          return { statusCode: 201, body: JSON.stringify(result.rows[0]) };
        }
        throw err;
      }
    }

    // [DELETE] ลบโมเดล
    if (method === 'DELETE') {
      const body = JSON.parse(event.body);
      const query = 'DELETE FROM api_models WHERE model_id = $1';
      await pool.query(query, [body.model_id]);
      return { statusCode: 200, body: JSON.stringify({ message: 'Deleted successfully' }) };
    }

    // [PUT] อัปเดตโมเดล
    if (method === 'PUT') {
      const body = JSON.parse(event.body);
      try {
        const query = 'UPDATE api_models SET name = $1, provider = $2, api_key = $3, base_url = $4 WHERE model_id = $5 RETURNING *';
        const values = [body.name, body.provider, body.key, body.base_url, body.model_id];
        const result = await pool.query(query, values);
        return { statusCode: 200, body: JSON.stringify(result.rows[0]) };
      } catch (err) {
        if (err.code === '42703' || err.message.includes('base_url')) {
          await pool.query('ALTER TABLE api_models ADD COLUMN base_url TEXT').catch(() => {});
          const query = 'UPDATE api_models SET name = $1, provider = $2, api_key = $3, base_url = $4 WHERE model_id = $5 RETURNING *';
          const values = [body.name, body.provider, body.key, body.base_url, body.model_id];
          const result = await pool.query(query, values);
          return { statusCode: 200, body: JSON.stringify(result.rows[0]) };
        }
        throw err;
      }
    }

    // หากเรียก Method อื่นๆ
    return { statusCode: 405, body: 'Method Not Allowed' };

  } catch (error) {
    console.error('Database Error:', error);
    // ส่ง details: error.message กลับไปให้หน้าเว็บแสดงผล
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: 'Internal Server Error', 
        details: error.message 
      }) 
    };
  }
};
