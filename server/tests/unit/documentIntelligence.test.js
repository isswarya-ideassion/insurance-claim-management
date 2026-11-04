import { describe, expect, it } from 'vitest'
import { buildTextPdf } from '../../src/utils/pdf.js'
import { extractPdfText } from '../../src/services/intelligence/pdfText.js'
import { extractAmount, extractIndianFields, maskAadhaar, parseIndianDate } from '../../src/services/intelligence/indianFields.js'
import { classify, crossValidate, tokenize, trainNaiveBayes } from '../../src/services/intelligence/naiveBayes.js'

const GARAGE_ESTIMATE = `SHREE AUTO WORKS
GST Invoice
GSTIN: 29ABCDE1234F1Z5
Invoice No: SAW/2026/0417
Vehicle Registration: MH 12 AB 1234
Date of Accident: 14/03/2026
Insured Name: Ramesh Kumar
Policy No: HP-MOT-889211

Front bumper replacement        18,400.00
Headlamp assembly               12,750.00
Labour charges                   6,200.00
Sub Total                       37,350.00
CGST 9%                          3,361.50
SGST 9%                          3,361.50
Grand Total                     44,073.00`

const HOSPITAL_BILL = `APOLLO SPECIALITY HOSPITAL
Final Bill of Supply
GSTIN: 33AACCA1234M1ZT
Bill No: APL/IP/55231
Patient Name: Sunita Devi
Policy No: HP-HLT-220914
Date of Admission: 02/08/2026
Room rent                       24,000.00
Surgery charges               1,85,000.00
Pharmacy                        31,450.00
Net Payable                   2,40,450.00`

describe('PDF text extraction', () => {
  it('reads back text written by the app PDF writer', () => {
    const pdf = buildTextPdf(GARAGE_ESTIMATE)
    const out = extractPdfText(pdf)
    expect(out.hasTextLayer).toBe(true)
    expect(out.text).toContain('SHREE AUTO WORKS')
    expect(out.text).toContain('29ABCDE1234F1Z5')
    expect(out.text).toContain('MH 12 AB 1234')
  })

  it('reports no text layer instead of returning nonsense', () => {
    expect(extractPdfText(Buffer.from('not a pdf at all')).hasTextLayer).toBe(false)
    expect(extractPdfText(buildTextPdf('hi')).hasTextLayer).toBe(false)
    expect(extractPdfText(Buffer.alloc(0)).text).toBe('')
  })

  it('round-trips escaped characters without corrupting them', () => {
    const out = extractPdfText(buildTextPdf('Policy (Motor) \\ Section 4 — repair cost Rs. 1,00,000'))
    expect(out.text).toContain('Policy (Motor)')
    expect(out.text).toContain('1,00,000')
  })
})

describe('Indian field extraction', () => {
  it('pulls statutory identifiers off a GST invoice', () => {
    const { identifiers } = extractIndianFields(GARAGE_ESTIMATE)
    const byType = Object.fromEntries(identifiers.map((i) => [i.type, i.value]))
    expect(byType.gstin).toBe('29ABCDE1234F1Z5')
    expect(byType.vehicle).toBe('MH12AB1234')
    // The PAN embedded inside the GSTIN must not be reported separately.
    expect(identifiers.filter((i) => i.type === 'pan')).toHaveLength(0)
  })

  it('picks the payable total, not a tax component or subtotal', () => {
    expect(extractAmount(GARAGE_ESTIMATE).value).toBe(44_073)
    expect(extractAmount(HOSPITAL_BILL).value).toBe(240_450)
  })

  it('reads dates the Indian way round', () => {
    // 03/04/2026 is 3 April, not 4 March. Misreading this can move a claim
    // outside the policy period.
    expect(parseIndianDate('Date of Loss: 03/04/2026')).toBe('2026-04-03')
    expect(parseIndianDate('Date of Accident: 14/03/2026')).toBe('2026-03-14')
    expect(parseIndianDate('Admitted on 2nd August 2026')).toBe('2026-08-02')
    expect(parseIndianDate('no date here')).toBeNull()
  })

  it('extracts labelled references and the loss date together', () => {
    const { fields } = extractIndianFields(GARAGE_ESTIMATE)
    expect(fields.policy_number).toBe('HP-MOT-889211')
    expect(fields.invoice_number).toBe('SAW/2026/0417')
    expect(fields.loss_date.value).toBe('2026-03-14')
    expect(fields.estimated_loss.value).toBe(44_073)
  })

  it('masks anything shaped like an Aadhaar and never extracts it', () => {
    const masked = maskAadhaar('Aadhaar: 4321 8765 2109 on file')
    expect(masked).toContain('XXXX XXXX 2109')
    expect(masked).not.toContain('4321 8765')
    expect(extractIndianFields('Aadhaar 4321 8765 2109').aadhaarPresent).toBe(true)
  })
})

describe('document classifier', () => {
  const corpus = [
    ...Array.from({ length: 6 }, (_, i) => ({ label: 'INVOICE', text: `${GARAGE_ESTIMATE}\nref ${i}` })),
    ...Array.from({ length: 6 }, (_, i) => ({ label: 'MEDICAL_REPORT', text: `${HOSPITAL_BILL}\ndischarge summary diagnosis treatment ${i}` })),
    ...Array.from({ length: 6 }, (_, i) => ({
      label: 'POLICE_REPORT',
      text: `FIRST INFORMATION REPORT\nFIR No: 221/2026\nPolice Station Andheri\nSection 279 IPC rash driving complainant statement ${i}`,
    })),
  ]

  it('learns the classes from labelled documents', () => {
    const model = trainNaiveBayes(corpus)
    expect(model.classes.sort()).toEqual(['INVOICE', 'MEDICAL_REPORT', 'POLICE_REPORT'])
    expect(classify(model, GARAGE_ESTIMATE).label).toBe('INVOICE')
    expect(classify(model, 'FIR No 19/2026 police station rash driving complainant').label).toBe('POLICE_REPORT')
  })

  it('reports measured accuracy rather than asserting it', () => {
    const result = crossValidate(corpus, { folds: 3 })
    expect(result.scored).toBeGreaterThan(0)
    expect(result.accuracy).toBeGreaterThan(0.8)
  })

  it('returns no label when the text shares nothing with the vocabulary', () => {
    const model = trainNaiveBayes(corpus)
    const out = classify(model, 'zzzz qqqq wwww')
    expect(out.label).toBeNull()
    expect(out.confidence).toBe(0)
  })

  it('collapses digits so invoice numbers are not memorised as features', () => {
    expect(tokenize('Invoice 55231 dated 2026')).toEqual(['invoice', '#num', 'dated', '#num'])
  })
})
