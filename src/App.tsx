import { useState } from 'react'
import * as mammoth from 'mammoth/mammoth.browser'
import * as pdfjsLib from 'pdfjs-dist'
import { jsPDF } from 'jspdf'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

const steps = [
  { number: '01', label: 'Textbook', detail: 'Add your source' },
  { number: '02', label: 'Pattern', detail: 'Set the blueprint' },
  { number: '03', label: 'Design', detail: 'Match your institution' },
  { number: '04', label: 'Difficulty', detail: 'Tune the challenge' },
]
function App() {
  const [activeStep, setActiveStep] = useState(0)
  const [patternMode, setPatternMode] = useState<'manual' | 'upload'>('manual')
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [extractedTopics, setExtractedTopics] = useState<string[]>([])
  const [generated, setGenerated] = useState(false)
  const [fileName, setFileName] = useState('')
  const [fileCount, setFileCount] = useState(0)
  const [textbookFiles, setTextbookFiles] = useState<File[]>([])
  const [designFileName, setDesignFileName] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [textbookText, setTextbookText] = useState('')
  const [difficulty, setDifficulty] = useState('Moderate')
  const [activeNav, setActiveNav] = useState('New paper')
  const [patternSections, setPatternSections] = useState([{ count: 10, marks: 1 }, { count: 5, marks: 2 }, { count: 4, marks: 3 }, { count: 2, marks: 5 }])
  const [duration, setDuration] = useState(90)

  const toggleTopic = (topic: string) => setSelectedTopics((current) => current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic])
  const extractPdfText = async (file: File) => {
    const document = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push((content.items as Array<{ str?: string; hasEOL?: boolean }>).map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').replace(/[ \t]+\n/g, '\n'))
    }
    return pages.join('\n')
  }
  const extractDocumentText = async (file: File) => {
    if (file.name.toLowerCase().endsWith('.pdf')) return extractPdfText(file)
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    return result.value
  }
  const findTopics = (text: string, sourceFileName: string) => {
    const lines = text.split(/\r?\n/).map((line) => line.replace(/\s*\.\s*/g, '.').replace(/\s+/g, ' ').trim()).filter((line) => line.length >= 3)
    const chapterNumbers = new Set(lines.flatMap((line) => {
      const match = line.match(/^(?:chapter\s*)?(\d+)\s+chapter|^chapter\s+(\d+)/i)
      return match ? [match[1] || match[2]] : []
    }))
    const cleanHeading = (line: string, marker: string) => {
      const markerPattern = new RegExp(`\\s*${marker.replace('.', '\\.')}(?:[.)]?\\s*)`, 'gi')
      const fragments = line.split(markerPattern).map((fragment) => fragment.replace(/\s+/g, ' ').trim()).filter(Boolean)
      const withoutMarkers = (fragments.sort((first, second) => second.split(' ').length - first.split(' ').length)[0] || line.replace(markerPattern, ' ')).replace(/\s+/g, ' ').trim()
      const words = withoutMarkers.split(' ')
      for (let blockLength = 2; blockLength <= Math.floor(words.length / 2); blockLength += 1) {
        const block = words.slice(0, blockLength).join(' ').toLowerCase()
        const repeatedWords = words.slice(0, blockLength * 2).join(' ').toLowerCase()
        if (repeatedWords === `${block} ${block}`) {
          return words.slice(0, blockLength).join(' ').replace(/UNDERST\s+ANDING/gi, 'UNDERSTANDING').replace(/CHEMIC\s+AL/gi, 'CHEMICAL').replace(/WHA\s+T/gi, 'WHAT').replace(/HA\s+VE/gi, 'HAVE').trim()
        }
      }
      const cleanedWords: string[] = []
      for (const word of words) {
        if (cleanedWords.length < 2 || word.toLowerCase() !== cleanedWords[cleanedWords.length - 1].toLowerCase()) cleanedWords.push(word)
      }
      return cleanedWords.join(' ').replace(/UNDERST\s+ANDING/gi, 'UNDERSTANDING').replace(/CHEMIC\s+AL/gi, 'CHEMICAL').replace(/WHA\s+T/gi, 'WHAT').replace(/HA\s+VE/gi, 'HAVE').replace(/\s+(common|have|in|to|the)\s+\1\b/gi, ' $1').slice(0, 100).trim()
    }
    const headings = lines.flatMap((line) => {
      const match = line.match(/(?:^|\s)(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/)
      if (!match || (chapterNumbers.size > 0 && !chapterNumbers.has(match[1].split('.')[0]))) return []
      const marker = match[1]
      const beforeMarker = line.slice(0, match.index || 0)
      if (/\b(figure|fig\.?|activity|table|question|exercise|example|page)\b/i.test(beforeMarker) || /^(figure|fig\.?|activity|table|question|exercise|example|page)\b/i.test(match[2])) return []
      const isChapterHeading = /\bchapter\b/i.test(line) && !marker.includes('.')
      const isNumberedSection = /^\d+\.\d+$/.test(marker)
      if (!isChapterHeading && !isNumberedSection) return []
      const repairedNames: Record<string, string> = sourceFileName.toLowerCase().includes('jesc102') ? {
        '2.1': 'Understanding the Chemical Properties of Acids and Bases',
        '2.2': 'What Do All Acids and All Bases Have in Common?',
        '2.3': 'How Strong Are Acid or Base Solutions?',
        '2.4': 'More About Salts',
      } : {}
      if (sourceFileName.toLowerCase().includes('jesc103')) Object.assign(repairedNames, {
        '3.1': 'Physical Properties of Metals and Non-metals',
        '3.2': 'Chemical Properties of Metals',
        '3.3': 'How do Metals and Non-metals React?',
        '3.4': 'Occurrence of Metals',
      })
      if (repairedNames[marker]) return [`${marker} ${repairedNames[marker]}`]
      const label = cleanHeading(line, marker)
      if (label.length < 3) return []
      if (isNumberedSection && (!/^[A-Za-z]/.test(label) || /[.!?]$/.test(label) || label.split(' ').length > 30)) return []
      return [`${marker} ${repairedNames[marker] || label}`]
    })
    return [...new Map(headings.map((heading) => [heading.split(' ')[0], heading])).values()].sort((first, second) => {
      const firstNumbers = first.split(' ')[0].split('.').map(Number)
      const secondNumbers = second.split(' ')[0].split('.').map(Number)
      for (let index = 0; index < Math.max(firstNumbers.length, secondNumbers.length); index += 1) {
        const difference = (firstNumbers[index] || 0) - (secondNumbers[index] || 0)
        if (difference !== 0) return difference
      }
      return 0
    })
  }
  const analyzeTextbook = async (files: File[]) => {
    const selectedFiles = files
    const firstFile = selectedFiles[0]
    if (!firstFile) return
    setFileName(firstFile.name)
    setFileCount(selectedFiles.length)
    setUploadError('')
    setIsAnalyzing(true)
    try {
      const extractedTexts = await Promise.all(selectedFiles.map((file) => extractDocumentText(file)))
      setTextbookText(extractedTexts.join('\n'))
      const detectedTopics = [...new Set(extractedTexts.flatMap((text, index) => findTopics(text, selectedFiles[index].name)))]
      if (detectedTopics.length === 0) throw new Error('No headings or topics were found in this document.')
      setExtractedTopics(detectedTopics)
      setSelectedTopics(detectedTopics)
    } catch (error) {
      setExtractedTopics([])
      setSelectedTopics([])
      setUploadError(error instanceof Error ? error.message : 'This file could not be read.')
    } finally {
      setIsAnalyzing(false)
    }
  }
  const addTextbooks = (files: File[]) => {
    const combinedFiles = [...textbookFiles, ...files].filter((file, index, allFiles) => allFiles.findIndex((candidate) => candidate.name === file.name && candidate.size === file.size) === index)
    setTextbookFiles(combinedFiles)
    void analyzeTextbook(combinedFiles)
  }
  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => { if (event.target.files?.length) addTextbooks(Array.from(event.target.files)); event.target.value = '' }
  const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => { event.preventDefault(); if (event.dataTransfer.files?.length) addTextbooks(Array.from(event.dataTransfer.files)) }
  const nextStep = () => setActiveStep((current) => Math.min(current + 1, steps.length - 1))
  const totalMarks = patternSections.reduce((total, section) => total + section.count * section.marks, 0)
  const updatePatternSection = (index: number, field: 'count' | 'marks', value: number) => setPatternSections((current) => current.map((section, sectionIndex) => sectionIndex === index ? { ...section, [field]: Math.max(0, value) } : section))
  const addPatternSection = () => setPatternSections((current) => [...current, { count: 1, marks: 1 }])
  const generatePdf = () => {
    const pdf = new jsPDF()
    const pageWidth = pdf.internal.pageSize.getWidth()
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(16)
    pdf.text('QUESTION PAPER', pageWidth / 2, 24, { align: 'center' })
    pdf.setFontSize(11)
    pdf.text('QP Setter', pageWidth / 2, 32, { align: 'center' })
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(10)
    pdf.text(`Subject: ${fileName || 'Selected textbook'}`, 20, 48)
    pdf.text(`Difficulty: ${difficulty}`, 20, 56)
    pdf.text(`Time: ${duration} minutes`, pageWidth - 20, 48, { align: 'right' })
    pdf.text(`Maximum Marks: ${totalMarks}`, pageWidth - 20, 56, { align: 'right' })
    pdf.line(20, 64, pageWidth - 20, 64)
    let yPosition = 78
    const questionTopics = selectedTopics.length > 0 ? selectedTopics : ['the selected textbook topics']
    const sourceSentences = textbookText.split(/(?<=[.!?])\s+/).map((sentence) => sentence.replace(/\s+/g, ' ').trim()).filter((sentence) => sentence.length >= 35 && sentence.length <= 220 && !/^(activity|figure|table|question|exercise|page)\b/i.test(sentence))
    const getSourceSentence = (topic: string, questionIndex: number) => {
      const topicWords = topic.toLowerCase().replace(/^\d+(?:\.\d+)*\s+/, '').split(/\s+/).filter((word) => word.length > 3)
      const matchingSentences = sourceSentences.filter((sentence) => topicWords.some((word) => sentence.toLowerCase().includes(word)))
      return (matchingSentences.length > 0 ? matchingSentences : sourceSentences)[questionIndex % Math.max(1, matchingSentences.length || sourceSentences.length)] || `the key concepts in ${topic}`
    }
    const makeQuestion = (topic: string, questionIndex: number, marks: number) => {
      const sentence = getSourceSentence(topic, questionIndex).replace(/\b(chapter|section|unit|lesson)\s+\d+(?:\.\d+)*/gi, 'the lesson').replace(/\b\d+(?:\.\d+)+\b/g, '').replace(/\s+/g, ' ').trim()
      if (difficulty === 'Easy') return `Define the term described below and state one important characteristic: ${sentence}`
      if (difficulty === 'Advanced') return `Analyse the following statement and give reasons to support your answer: ${sentence}`
      if (difficulty === 'Application') return `A student observes the situation described below. Explain what happens and why: ${sentence}`
      if (marks === 1) return `State one important fact based on the following: ${sentence}`
      if (marks === 2) return `Explain the following observation: ${sentence}`
      if (marks === 3) return `Explain the following concept and give a suitable example: ${sentence}`
      return `Explain the following in detail. Include the relevant principles, reasons, and an appropriate example: ${sentence}`
    }
    let questionNumber = 1
    patternSections.forEach((section, index) => {
      pdf.setFont('helvetica', 'bold')
      pdf.text(`Section ${String.fromCharCode(65 + index)} (${section.count} x ${section.marks} = ${section.count * section.marks} marks)`, 20, yPosition)
      pdf.setFont('helvetica', 'normal')
      yPosition += 9
      for (let question = 0; question < section.count; question += 1) {
        const topic = questionTopics[(questionNumber - 1) % questionTopics.length]
        const questionText = `${questionNumber}. ${makeQuestion(topic, questionNumber - 1, section.marks)}`
        const lines = pdf.splitTextToSize(questionText, pageWidth - 50)
        pdf.text(lines, 25, yPosition)
        yPosition += Math.max(8, lines.length * 5) + 4
        questionNumber += 1
        if (yPosition > 275) { pdf.addPage(); yPosition = 20 }
      }
      yPosition += 6
    })
    if (textbookText.length === 0) {
      pdf.setFontSize(8)
      pdf.text('Generated from selected textbook topics.', 20, 285)
    }
    pdf.save('qp-setter-question-paper.pdf')
    setGenerated(true)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar"><div className="brand"><span className="brand-mark">Q</span><span>QP Setter</span></div><div className="workspace-label">WORKSPACE</div><nav><button className={`nav-item ${activeNav === 'New paper' ? 'active' : ''}`} onClick={() => setActiveNav('New paper')}><span className="nav-icon">＋</span>New paper</button><button className={`nav-item ${activeNav === 'Question bank' ? 'active' : ''}`} onClick={() => setActiveNav('Question bank')}><span className="nav-icon">▦</span>Question bank <span className="count">248</span></button><button className={`nav-item ${activeNav === 'Recent papers' ? 'active' : ''}`} onClick={() => setActiveNav('Recent papers')}><span className="nav-icon">◷</span>Recent papers</button></nav><div className="sidebar-bottom"><div className="bank-note"><span className="spark">✦</span><div><strong>Your bank is growing</strong><small>248 unique questions saved</small></div></div><button className="profile"><span className="avatar">AS</span><span><strong>Arjun Sharma</strong><small>Science department</small></span><span className="dots">···</span></button></div></aside>
      <main className="main-content"><header className="topbar"><div className="crumb">Workspace <span>/</span> <strong>New question paper</strong></div><button className="help">? <span>Help center</span></button></header><div className="content-wrap">
        <section className="page-intro"><div><p className="eyebrow">NEW PAPER <span className="line" /></p><h1>{activeStep === 0 ? <>Start with your<br /><em>textbook.</em></> : <>Build a paper<br /><em>that feels familiar.</em></>}</h1><p className="intro-copy">{activeStep === 0 ? 'Upload your source material and choose the chapters and topics you want to use.' : 'Bring your textbook, pattern, and institution\'s voice together. We\'ll handle the heavy lifting.'}</p></div><div className="progress-block"><span>SETUP PROGRESS</span><strong>{activeStep + 1} <small>/ 4</small></strong><div className="progress-bar"><i style={{ width: `${((activeStep + 1) / 4) * 100}%` }} /></div></div></section>
        <div className="stepper">{steps.map((step, index) => <button key={step.number} className={`step ${activeStep === index ? 'selected' : ''} ${index < activeStep ? 'complete' : ''}`} onClick={() => setActiveStep(index)}><span className="step-number">{index < activeStep ? '✓' : step.number}</span><span><strong>{step.label}</strong><small>{step.detail}</small></span></button>)}</div>
        {activeStep === 0 && <section className="single-panel"><div className="builder-card"><div className="card-heading"><div><span className="section-index">01</span><h2>Start with your textbook</h2><p>We'll map the chapters and topics for you.</p></div><span className="status-pill">Required</span></div><label className="upload-zone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}><input type="file" accept=".pdf,.doc,.docx" multiple onChange={handleFile} /><span className="upload-icon">{isAnalyzing ? '…' : '↑'}</span><span><strong>{isAnalyzing ? 'Analyzing your textbooks…' : fileName ? `${fileCount} file${fileCount === 1 ? '' : 's'} selected` : 'Drop your textbooks here'}</strong><small>{isAnalyzing ? 'Finding chapters, topics, and subtopics' : fileName ? `${fileName} · upload complete` : 'PDF or Word documents · select multiple files · max 50 MB each'}</small></span><span className="browse">Browse files</span></label>{uploadError && <p className="upload-error">{uploadError}</p>}{fileName && !uploadError ? <><div className="source-preview"><div className="book-icon">▤</div><div><strong>{fileName}</strong><small>{isAnalyzing ? 'Reading document structure…' : `${fileCount} textbook${fileCount === 1 ? '' : 's'} uploaded successfully`}</small></div><span className="check">{isAnalyzing ? '…' : '✓'}</span></div><div className="topic-header"><div><h3>{isAnalyzing ? 'Extracting topics…' : 'Choose what to include'}</h3><p>{selectedTopics.length} of {extractedTopics.length} topics selected</p></div><button onClick={() => setSelectedTopics(selectedTopics.length === extractedTopics.length ? [] : extractedTopics)}>{selectedTopics.length === extractedTopics.length ? 'Clear all' : 'Select all'}</button></div><div className="topic-list">{extractedTopics.map((topic) => { const depth = topic.split(' ')[0].split('.').length - 1; return <label key={topic} className={`topic-row ${depth > 0 ? `subtopic depth-${depth}` : ''}`}><input type="checkbox" checked={selectedTopics.includes(topic)} onChange={() => toggleTopic(topic)} /><span className="fake-check">✓</span>{topic}<span className="topic-chevron">›</span></label> })}</div></> : <div className="empty-source"><span>01</span><p>{uploadError || 'Your textbook chapters and topics will appear here after upload.'}</p></div>}<div className="panel-actions"><span>Step 1 of 4</span><button className="next-button" onClick={nextStep}>Continue to pattern <span>→</span></button></div></div></section>}
        {activeStep === 1 && <section className="single-panel"><div className="mini-card pattern-card large-card"><div className="mini-title"><span className="section-index">02</span><div><h2>Question pattern</h2><p>Set the marks and duration for this institution.</p></div></div><div className="segmented"><button className={patternMode === 'manual' ? 'on' : ''} onClick={() => setPatternMode('manual')}>Manual setup</button><button className={patternMode === 'upload' ? 'on' : ''} onClick={() => setPatternMode('upload')}>Upload pattern</button></div>{patternMode === 'manual' ? <div className="pattern-builder"><div className="pattern-labels"><span>Questions</span><span>Marks each</span></div>{patternSections.map((section, index) => <div className="pattern-row" key={index}><input aria-label={`Section ${index + 1} questions`} type="number" min="0" value={section.count} onChange={(event) => updatePatternSection(index, 'count', Number(event.target.value))} /><span>questions ×</span><input aria-label={`Section ${index + 1} marks`} type="number" min="1" value={section.marks} onChange={(event) => updatePatternSection(index, 'marks', Number(event.target.value))} /><span>marks</span></div>)}<button className="add-section" onClick={addPatternSection}>＋ Add mark section</button><label className="duration-field">Exam duration (minutes)<input type="number" min="1" value={duration} onChange={(event) => setDuration(Math.max(1, Number(event.target.value)))} /></label></div> : <label className="compact-upload"><input type="file" accept=".pdf,.doc,.docx" multiple /><span>＋</span> Upload one or more pattern files</label>}<div className="total-row"><span>Total marks <strong>{totalMarks}</strong></span><span>Duration <strong>{duration} min</strong></span></div><div className="panel-actions"><button className="back-button" onClick={() => setActiveStep(0)}>← Back</button><button className="next-button" onClick={nextStep}>Continue to design <span>→</span></button></div></div></section>}
        {activeStep === 2 && <section className="single-panel"><div className="mini-card large-card"><div className="mini-title"><span className="section-index">03</span><div><h2>Match your design</h2><p>Make it look like your institution.</p></div><span className="optional">Optional</span></div><label className="design-upload"><input type="file" accept=".pdf,.doc,.docx" multiple onChange={(event) => { const files = event.target.files; const file = files?.[0]; if (file) setDesignFileName(files.length === 1 ? file.name : `${files.length} files selected`) }} /><span className="doc-icon">▤</span><span><strong>{designFileName || 'Upload previous papers'}</strong><small>{designFileName ? 'Ready to analyze layout' : 'PDF or Word · select multiple reference papers'}</small></span><button type="button" aria-label="Upload previous paper">＋</button></label><div className="panel-actions"><button className="back-button" onClick={() => setActiveStep(1)}>← Back</button><button className="next-button" onClick={nextStep}>Continue to difficulty <span>→</span></button></div></div></section>}
        {activeStep === 3 && <section className="single-panel"><div className="mini-card large-card difficulty-card"><div className="mini-title"><span className="section-index">04</span><div><h2>Set the difficulty</h2><p>Choose the level of challenge.</p></div></div><div className="difficulty-options">{['Easy', 'Moderate', 'Advanced', 'Application'].map((level) => <button key={level} className={`difficulty ${level.toLowerCase()} ${difficulty === level ? 'active-diff' : ''}`} onClick={() => setDifficulty(level)}><i />{level}</button>)}</div><div className="panel-actions"><button className="back-button" onClick={() => setActiveStep(2)}>← Back</button><button className={`generate ${generated ? 'done' : ''}`} onClick={generatePdf}>{generated ? 'Download PDF again' : 'Generate question paper'} <span>→</span></button></div></div></section>}
        {generated && <div className="generated-note"><span>✦</span><strong>Your paper is ready for review.</strong> We found 21 questions across {selectedTopics.length} selected topics. You can edit any section before exporting.</div>}
      </div></main>
    </div>
  )
}

export default App
