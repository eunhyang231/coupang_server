// index.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch'); // npm install node-fetch@2

// ========================================
// 🐘 Supabase PostgreSQL 연결 준비
// v0.4 - 2026-07-18
// ========================================
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// 🔐 쿠팡 OPEN API 키 (네 키로 바꿔 넣기)
const COUPANG_ACCESS_KEY = process.env.COUPANG_ACCESS_KEY;
const COUPANG_SECRET_KEY = process.env.COUPANG_SECRET_KEY;
const COUPANG_VENDOR_ID = process.env.COUPANG_VENDOR_ID;
const COUPANG_DOMAIN = process.env.COUPANG_DOMAIN;

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./price_history.db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// ✅ Supabase 연결 확인용 임시 주소
// 성공 확인 후 나중에 삭제할 예정
// ========================================
app.get('/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');

    res.json({
      success: true,
      message: 'Supabase 연결 성공!',
      serverTime: result.rows[0].server_time,
    });
  } catch (error) {
    console.error('Supabase 연결 실패:', error.message);

    res.status(500).json({
      success: false,
      message: 'Supabase 연결 실패',
    });
  }
});

// ==================================================
// 🔕 관심상품 비활성화 API
//
// v0.1
// 2026-07-19
// - deviceId와 productId 기준 알림 끄기
// ==================================================
app.patch('/watched-products', async (req, res) => {
  // 앱에서 기기 ID와 상품 ID 받기
  const { deviceId, productId } = req.body;

  // 필수 정보 확인
  if (!deviceId || !productId) {
    return res.status(400).json({
      success: false,
      message: '기기 ID와 상품 ID가 필요해요.',
    });
  }

  // DB 연결
  const client = await pool.connect();

  try {
    // 관심상품 비활성화
    await client.query(
      `
      UPDATE watched_products
      SET is_active = false
      WHERE device_id = $1
        AND product_id = $2
      `,
      [deviceId, productId],
    );

    return res.json({
      success: true,
    });
  } finally {
    // DB 연결 반환
    client.release();
  }

  return res.json({
    success: true,
  });
});

// ========================================
// ❤️ 관심상품 Supabase 저장 API
// v0.5 - 2026-07-18
// ========================================
app.post('/watched-products', async (req, res) => {
  // 앱에서 전달받은 관심상품 정보 확인
  console.log('[WATCHED_PRODUCTS] req.body =', req.body);

  const {
    deviceId,
    productId,
    productName,
    searchKeyword,
    imageUrl,
    productUrl,
    currentPrice,
  } = req.body;

  // 필수 데이터가 빠졌는지 확인
  if (
    !deviceId ||
    !productId ||
    !productName ||
    !searchKeyword ||
    !Number.isInteger(currentPrice) ||
    currentPrice <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: '관심상품 정보가 올바르지 않아요.',
    });
  }

  const client = await pool.connect();

  try {
    // 관심상품과 최초 가격 기록을 함께 안전하게 저장
    await client.query('BEGIN');

    const productResult = await client.query(
      `
      INSERT INTO watched_products (
        device_id,
        product_id,
        product_name,
        search_keyword,
        image_url,
        product_url,
        current_price,
        is_active,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
      ON CONFLICT (device_id, product_id)
      DO UPDATE SET
        product_name = EXCLUDED.product_name,
        search_keyword = EXCLUDED.search_keyword,
        image_url = EXCLUDED.image_url,
        product_url = EXCLUDED.product_url,
        current_price = EXCLUDED.current_price,
        is_active = true,
        updated_at = NOW()
      RETURNING *
      `,
      [
        deviceId,
        productId,
        productName,
        searchKeyword,
        imageUrl || null,
        productUrl || null,
        currentPrice,
      ],
    );

    // 해당 상품의 가장 최근 가격 확인
    const lastPriceResult = await client.query(
      `
      SELECT price
      FROM price_history
      WHERE product_id = $1
      ORDER BY captured_at DESC
      LIMIT 1
      `,
      [productId],
    );

    // 최초 가격이거나 기존 가격과 달라졌을 때만 기록
    const lastPrice = lastPriceResult.rows[0]?.price;

    if (lastPrice !== currentPrice) {
      await client.query(
        `
        INSERT INTO price_history (product_id, price)
        VALUES ($1, $2)
        `,
        [productId, currentPrice],
      );
    }

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: '관심상품이 저장됐어요!',
      product: productResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');

    console.error('관심상품 저장 실패:', error.message);

    return res.status(500).json({
      success: false,
      message: '관심상품 저장에 실패했어요.',
    });
  } finally {
    // 사용한 DB 연결을 반드시 반환
    client.release();
  }
});

// ==================================================
// 💙 관심상품 목록 조회 API
//
// v0.1
// 2026-07-19
// - deviceId 기준 관심상품 조회
// ==================================================
app.get('/watched-products', async (req, res) => {
  // 앱에서 전달받은 기기 ID 확인
  const { deviceId } = req.query;

  // 기기 ID가 없으면 요청 중단
  if (!deviceId) {
    return res.status(400).json({
      success: false,
      message: '기기 ID가 필요해요.',
    });
  }

// DB 연결
const client = await pool.connect();

try {
  // 관심상품 조회
  const result = await client.query(
    `
    SELECT *
    FROM watched_products
    WHERE device_id = $1
      AND is_active = true
    ORDER BY updated_at DESC
    `,
    [deviceId],
  );

  return res.json({
    success: true,
    products: result.rows,
  });
} finally {
  // DB 연결 반환
  client.release();
}
});

// ==================================================
// 📦 가격 확인 대상 상품 조회
//
// v0.1
// 2026-07-19
// - 활성화된 관심상품을 상품별로 한 번만 조회
// ==================================================
app.get('/active-products', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (product_id)
        product_id,
        product_name,
        search_keyword,
        product_url,
        current_price
      FROM watched_products
      WHERE is_active = true
      ORDER BY product_id, updated_at DESC
    `);

    return res.json({
      success: true,
      products: result.rows,
    });
  } catch (error) {
    console.error('가격 확인 대상 조회 실패:', error.message);

    return res.status(500).json({
      success: false,
      message: '가격 확인 대상을 불러오지 못했어요.',
    });
  }
});

// ==================================================
// 💰 가격 확인 엔진
//
// v0.1
// 2026-07-20
// - 가격 확인 엔진 시작
// ==================================================
app.get('/check-price', async (req, res) => {

  console.log('가격 확인 시작');

  return res.json({
    success: true,
    message: '가격 확인 엔진 시작',
  });

});

// HMAC 서명 생성 함수
function generateHmac(method, uri, accessKey, secretKey) {
  // uri 예: "/v2/providers/.../products/search?keyword=...&limit=10"
  const parts = uri.split('?');
  const path = parts[0];
  const query = parts.length === 2 ? parts[1] : '';

  // 쿠팡 포맷: yyMMdd'T'HHmmss'Z' (UTC)
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const MM = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const HH = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  const datetime = `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;

  const message = datetime + method + path + query;

  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  // ⚠ 쉼표 뒤에 공백 절대 X
  const authorization =
    `CEA algorithm=HmacSHA256,access-key=${accessKey},signed-date=${datetime},signature=${signature}`;

  return { authorization };
}

function extractProductId(link) {
  if (!link) return null;
  const match = String(link).match(/products\/(\d+)/);
  return match ? match[1] : null;
}

// 처음 서버 켜질 때 테이블 없으면 만들기
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      price INTEGER NOT NULL,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_price_history_product
    ON price_history(product_id, captured_at)
  `);
});

// server.js 상단/중간 어딘가
const products = [
  {
    id: '1',
    name: '예시 상품 1',
    price: 10000,
    coupangUrl: 'https://www.coupang.com/vp/products/1234567890'
  },
  {
    id: '2',
    name: '예시 상품 2',
    price: 20000,
    coupangUrl: 'https://www.coupang.com/vp/products/9876543210'
  }
  // ... 실제로는 검색 결과에서 넘어온 데이터 사용
];

// 상품 상세 페이지
app.get('/product/:id', (req, res) => {
  const { id } = req.params;
  const product = products.find(p => p.id === id);

  if (!product) {
    return res.status(404).send('상품을 찾을 수 없습니다.');
  }

  // EJS 템플릿에 product 넘겨줌
  res.render('product', { product });
});

// 쿠팡으로 리다이렉트
app.get('/go-coupang/:id', (req, res) => {
  const { id } = req.params;
  const product = products.find(p => p.id === id);

  if (!product || !product.coupangUrl) {
    return res.status(404).send('쿠팡 링크를 찾을 수 없습니다.');
  }

  // 여기서 실제 쿠팡 링크로 이동
  res.redirect(product.coupangUrl);
});




// 서버 살아있는지 확인용
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// 🔍 검색 API
app.get('/search', async (req, res) => {
  const keyword = (req.query.query || '').trim();
  console.log('[SEARCH] keyword =', keyword);

  if (!keyword) {
    return res.json([]);
  }

  const method = 'GET';
  const encodedKeyword = encodeURIComponent(keyword);

  // 서명과 실제 호출에 똑같이 사용할 URI
  const uri =
    `/v2/providers/affiliate_open_api/apis/openapi/v1/products/search?keyword=${encodedKeyword}&limit=10`;

  try {
    const { authorization } = generateHmac(
      method,
      uri,
      COUPANG_ACCESS_KEY,
      COUPANG_SECRET_KEY,
    );

    const url = `${COUPANG_DOMAIN}${uri}`;
    console.log('[SEARCH] request URL =', url);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
      },
    });

    const text = await response.text();
    console.log('[SEARCH] Coupang status =', response.status);
    console.log('[SEARCH] Coupang body   =', text);

    // 실패하면 그냥 빈 리스트 (앱은 에러 안 나게)
    if (!response.ok) {
      return res.json([]);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error('[SEARCH] JSON parse error:', e);
      return res.json([]);
    }

    let list = [];
    if (Array.isArray(json.data)) {
      list = json.data;
    } else if (json.data && Array.isArray(json.data.productData)) {
      list = json.data.productData;
    } else if (Array.isArray(json.products)) {
      list = json.products;
    }

    if (list.length > 0) {
      console.log('===== SAMPLE ITEM =====');
      console.log(JSON.stringify(list[0], null, 2));
      console.log('=======================');
    }
    const items = list.map((item) => {
          const name = item.productName;
          const price = item.productPrice;
          const rocket = item.isRocket ?? false;
          const image = item.productImage;
          const productId = String(item.productId); // 쿠팡에서 내려주는 productId

          const link = `https://www.coupang.com/vp/products/${productId}`;

          // price_history 테이블에 기록 남기기
           if (productId && price > 0) {
                  console.log('[PRICE_HISTORY] insert', productId, price);
                  db.run(
                    'INSERT INTO price_history (product_id, price, captured_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
                    [productId, price],
                  );
                }

          return {
            name,
            price,
            rocket,
            coupon: false, // JSON에 없으므로 기본값 false
            image,
            link,
            productId, // 🔥 Flutter에서 쓸 수 있게 같이 내려주기
          };
        });

        console.log('[SEARCH] mapped items length =', items.length);
        res.json(items);
      } catch (err) {
        console.error('[SEARCH] server error:', err);
        res.json([]);
      }
    });


app.get('/price-history', (req, res) => {
  const { productId } = req.query;
  const limit = Number(req.query.limit || 20); // 최근 N개만

  if (!productId) {
    return res.status(400).json({ error: 'productId required' });
  }

  db.all(
    `
      SELECT price, captured_at
      FROM price_history
      WHERE product_id = ?
      ORDER BY captured_at ASC
      LIMIT ?
    `,
    [productId, limit],
    (err, rows) => {
      if (err) {
        console.error('[PRICE_HISTORY] db error:', err);
        return res.status(500).json({ error: 'db error' });
      }
      res.json(rows);
    },
  );
});



app.get('/', (req, res) => {
  res.send('Coupang price compare API is running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

