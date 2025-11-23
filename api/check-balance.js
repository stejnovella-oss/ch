const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const TWO_CAPTCHA_API_KEY = process.env.TWOCAPTCHA_KEY; // Из Vercel env

async function solveRecaptcha(siteKey, pageUrl) {
  const submit = await fetch(`http://2captcha.com/in.php?key=${TWO_CAPTCHA_API_KEY}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${pageUrl}&json=1`);
  const submitRes = await submit.json();
  if (submitRes.status !== 1) throw new Error('Captcha submit failed');

  const captchaId = submitRes.request;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const getRes = await fetch(`http://2captcha.com/res.php?key=${TWO_CAPTCHA_API_KEY}&action=get&id=${captchaId}&json=1`);
    const getData = await getRes.json();
    if (getData.status === 1) return getData.request;
  }
  throw new Error('Captcha solve timeout');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { brand, card, pin } = req.body;

  try {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    let url;
    switch (brand) {
      case 'darden': url = 'https://www.darden.com/gift-cards/check-balance'; break;
      case 'texasroadhouse': url = 'https://www.texasroadhouse.com/gift-cards/check-balance'; break;
      case 'outback': url = 'https://www.outback.com/gift-cards/check-balance'; break;
      case 'chilis': url = 'https://www.chilis.com/gift-card-balance'; break;
      case 'panera': url = 'https://www.panerabread.com/en-us/gift-card-balance.html'; break;
      case 'redlobster': url = 'https://www.redlobster.com/gift-cards/check-balance'; break;
      case 'crackerbarrel': url = 'https://www.crackerbarrel.com/gift-cards/balance'; break;
      default: throw new Error('Unknown brand');
    }

    await page.goto(url, { waitUntil: 'networkidle2' });

    // Решаем reCAPTCHA v3
    const siteKey = await page.evaluate(() => {
      const el = document.querySelector('div[data-sitekey]');
      return el ? el.dataset.sitekey : null;
    });
    if (siteKey) {
      const token = await solveRecaptcha(siteKey, url);
      await page.evaluate((t) => {
        const input = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (input) input.value = t;
      }, token);
    }

    // Заполняем форму
    await page.type('input[name="giftCardNumber"], input[placeholder*="Card Number"], input[id*="card"]', card);
    if (pin) await page.type('input[name="pin"], input[placeholder*="PIN"], input[id*="pin"]', pin);

    // Кликаем кнопку
    await page.click('button[type="submit"], input[type="submit"], button:contains("Check"), .btn-check');
    await page.waitForTimeout(5000);  // Ждём ответа

    // Парсим баланс
    const balanceText = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/balance[:\s]*\$?([0-9,]+\.?[0-9]*)/i);
      return match ? match[1] : null;
    });

    await browser.close();

    if (balanceText) {
      const balance = parseFloat(balanceText.replace(/,/g, ''));
      const payout = (balance * 0.55).toFixed(2);
      res.json({ success: true, balance, payout, message: `Баланс $${balance}, выплата ${payout} USDT` });
    } else {
      res.json({ success: false, message: 'Баланс не найден — проверь PIN или пришли в Telegram' });
    }
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: 'Ошибка — пришли данные в Telegram' });
  }
};
