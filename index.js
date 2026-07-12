// index.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch'); // npm install node-fetch@2

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


    /*
    const items = list.map((item) => ({
      name: item.productName,
      price: item.productPrice,
      rocket: item.isRocket ?? false,
      coupon: false, // JSON에 없으므로 기본값 false
      image: item.productImage,
      link: `https://www.coupang.com/vp/products/${item.productId}`,
    }));


    console.log('[SEARCH] mapped items length =', items.length);

    res.json(items);
  } catch (err) {
    console.error('[SEARCH] server error:', err);
    res.json([]);
  }
});*/

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

