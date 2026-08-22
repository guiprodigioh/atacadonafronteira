import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getConfig } from '@/lib/config'

const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM = 'Atacado na Fronteira <noreply@atacadonafronteira.com>'

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return false
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    })
    return res.ok
  } catch { return false }
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`
  if (process.env.CRON_SECRET && auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = await getConfig()
  const minMinutes = config.recovery_abandono_min || 120
  const cutoff = new Date(Date.now() - minMinutes * 60_000).toISOString()
  const recentLimit = new Date(Date.now() - 24 * 60 * 60_000).toISOString()

  const { data: abandonos } = await supabaseAdmin
    .from('cart_sessions')
    .select('id, nome, telefone, email, itens, total_usd, created_at, contatado, convertido')
    .lt('created_at', cutoff)
    .gt('created_at', recentLimit)
    // As duas colunas têm `default false`, não NULL — `.is(null)` não casa com
    // `false` e a query devolvia ZERO linhas desde sempre, com o cron
    // respondendo {ok:true} a cada 2h. Nenhum dos 14 carrinhos salvos até
    // 22/08/2026 chegou a ser contatado por causa disto.
    .or('convertido.is.null,convertido.eq.false')
    .or('contatado.is.null,contatado.eq.false')
    .order('created_at', { ascending: false })
    .limit(50)

  if (!abandonos?.length) {
    return NextResponse.json({
      ok: true, candidatos: 0, enviados: 0, falhas: 0,
      janela: { de: recentLimit, ate: cutoff, minutos_minimos: minMinutes },
    })
  }

  let enviados = 0
  let falhas = 0
  for (const cart of abandonos) {
    let enviou = false
    const itensArr = Array.isArray(cart.itens) ? cart.itens : []
    const linhas = itensArr.slice(0, 5).map((i: { name?: string; qty?: number }) =>
      `<tr><td style="padding:6px 0;font-size:13px;color:#555">${i.name || ''} ×${i.qty || 1}</td></tr>`).join('')
    const totalBrl = (cart.total_usd || 0) * config.brl_rate

    if (cart.email) {
      const html = config.recovery_template || `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a0a;font-family:Arial,sans-serif">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px"><tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px"><tr><td style="background:#0e0e0e;padding:32px;border-radius:12px;border:1px solid #1a1a1a">
        <h2 style="margin:0 0 8px;font-size:20px;color:#fff">Você esqueceu seu carrinho 🛒</h2>
        <p style="color:#888;font-size:15px;line-height:1.6;margin:0 0 24px">${cart.nome || 'Olá'}, seus itens ainda estão te esperando:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border-radius:10px;padding:16px;margin-bottom:20px">${linhas}</table>
        <p style="font-size:16px;color:#A965ED;font-weight:900;margin:0 0 24px">Total: R$ ${totalBrl.toFixed(2).replace('.', ',')}</p>
        <a href="https://atacadonafronteira.com/" style="display:inline-block;background:#A965ED;color:#000;font-weight:900;font-size:15px;padding:14px 32px;border-radius:10px;text-decoration:none">Finalizar Compra →</a>
        <p style="font-size:11px;color:#444;margin-top:24px">Atacado na Fronteira${config.whatsapp ? ` · WhatsApp ${config.whatsapp}` : ''}</p>
        </td></tr></table></td></tr></table></body></html>`
      const ok = await sendEmail(cart.email, `${cart.nome || 'Olá'}, você esqueceu seu carrinho 🛒`, html)
      if (ok) enviados++
      enviou = ok
    }

    // Só marca como contatado se a mensagem REALMENTE saiu. Antes marcava
    // sempre: uma falha do Resend queimava o carrinho para sempre, sem retry e
    // sem log. Carrinho sem e-mail também é marcado — não há o que retentar.
    if (enviou || !cart.email) {
      await supabaseAdmin.from('cart_sessions').update({ contatado: true }).eq('id', cart.id)
    } else {
      falhas++
    }
  }

  // A resposta descreve a janela e o que sobrou. `{ok:true, processados:0}` era
  // indistinguível de "filtro quebrado" e de "não há nada a fazer" — foi o que
  // escondeu o bug acima por meses.
  return NextResponse.json({
    ok: true,
    janela: { de: recentLimit, ate: cutoff, minutos_minimos: minMinutes },
    candidatos: abandonos.length, enviados, falhas,
  })
}
