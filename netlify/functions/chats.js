const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event, context) => {
  const method = event.httpMethod;

  try {
    // [GET] ดึงรายชื่อแชททั้งหมด หรือ ดึงข้อความในแชท
    if (method === 'GET') {
      const { session_id } = event.queryStringParameters || {};
      
      if (session_id) {
        // ดึงข้อความของแชทนั้นๆ
        const result = await pool.query('SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id ASC', [session_id]);
        return { statusCode: 200, body: JSON.stringify(result.rows) };
      } else {
        // ดึงรายชื่อประวัติแชททั้งหมด
        const result = await pool.query('SELECT * FROM chat_sessions ORDER BY created_at DESC');
        return { statusCode: 200, body: JSON.stringify(result.rows) };
      }
    }

    // [POST] บันทึกข้อความใหม่ (สร้าง session อัตโนมัติถ้ายังไม่มี)
    if (method === 'POST') {
      const { session_id, role, content, html_content } = JSON.parse(event.body);
      
      // ตรวจสอบว่ามี session นี้หรือยัง
      const sessionCheck = await pool.query('SELECT id FROM chat_sessions WHERE id = $1', [session_id]);
      
      if (sessionCheck.rowCount === 0 && role === 'user') {
        // สร้างชื่อแชทจากข้อความแรก (ตัดคำให้สั้นลง)
        const title = content.substring(0, 30) + (content.length > 30 ? '...' : '');
        await pool.query('INSERT INTO chat_sessions (id, title) VALUES ($1, $2)', [session_id, title]);
      }

      // บันทึกข้อความ
      const query = 'INSERT INTO chat_messages (session_id, role, content, html_content) VALUES ($1, $2, $3, $4) RETURNING *';
      const result = await pool.query(query, [session_id, role, content, html_content || null]);
      
      return { statusCode: 201, body: JSON.stringify(result.rows[0]) };
    }

    // [DELETE] ลบประวัติแชท
    if (method === 'DELETE') {
      const { session_id } = JSON.parse(event.body);
      await pool.query('DELETE FROM chat_sessions WHERE id = $1', [session_id]);
      return { statusCode: 200, body: JSON.stringify({ message: 'Chat deleted' }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };

  } catch (error) {
    console.error('Database Error:', error);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: 'Internal Server Error', 
        details: error.message 
      }) 
    };
  }
};