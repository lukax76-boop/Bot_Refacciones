const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Header, Footer, SimpleField } = require('docx');


const colors = {
    primary: '#1e3a8a',    // Azul marino profundo
    secondary: '#2563eb',  // Azul rey brillante
    accent: '#0d9488',     // Verde azulado
    dark: '#1e293b',       // Pizarra oscuro para texto principal
    lightBg: '#f8fafc',    // Fondo grisáceo muy claro para cajas de notas
    border: '#cbd5e1',     // Gris claro para líneas divisorias
    muted: '#64748b'       // Gris medio para subtítulos y pie de página
};

// =============================================================================
// PARTE 1: GENERACIÓN DEL PDF (OPTIMIZADO Y SIN PÁGINAS EN BLANCO)
// =============================================================================

function generatePDF() {
    // Crear documento PDF con márgenes estándar de 0.75 in (54 pt) y bufferPages para numeración dinámica
    const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 54, bottom: 54, left: 54, right: 54 },
        bufferPages: true
    });

    const pdfPath = path.join(__dirname, 'MANUAL_SISTEMA_REFACCIONES.pdf');
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // --- PÁGINA 1: PORTADA ---
    // Fondo decorativo azul marino en la parte superior
    doc.rect(0, 0, doc.page.width, 240).fill(colors.primary);

    // Título principal en blanco
    doc.fillColor('#ffffff')
       .fontSize(24)
       .font('Helvetica-Bold')
       .text('🤖 SISTEMA DE COTIZACIONES\nY BUSCADOR DE REFACCIONES', 54, 75, { lineGap: 6 });

    // Subtítulo en azul claro brillante
    doc.fillColor('#93c5fd')
       .fontSize(14)
       .font('Helvetica')
       .text('Manual de Usuario y Guía de Operación Completa', 54, 155);

    // Resumen/Descripción principal
    doc.fillColor(colors.dark)
       .fontSize(10.5)
       .font('Helvetica')
       .text('Un sistema inteligente diseñado para simplificar la consulta de inventarios, automatizar ventas e interconectar a clientes con agentes comerciales en tiempo real mediante WhatsApp y la Web.', 54, 280, { width: 504, align: 'justify', lineGap: 4 });

    // Cuadro de información general / metadatos
    const boxY = 380;
    doc.rect(54, boxY, 504, 180)
       .fillAndStroke(colors.lightBg, colors.border);

    doc.fillColor(colors.primary)
       .fontSize(12)
       .font('Helvetica-Bold')
       .text('INFORMACIÓN GENERAL DEL DOCUMENTO', 74, boxY + 20);

    doc.fillColor(colors.dark)
       .fontSize(9.5)
       .font('Helvetica')
       .text('• Dirigido a:', 74, boxY + 55)
       .font('Helvetica-Bold')
       .text('Usuarios finales, agentes de venta y personal operativo (No técnico).', 170, boxY + 55);

    doc.font('Helvetica')
       .text('• Tecnología:', 74, boxY + 85)
       .font('Helvetica-Bold')
       .text('WhatsApp Business API, Inteligencia Artificial Gemini y Panel Web.', 170, boxY + 85);

    doc.font('Helvetica')
       .text('• Actualización:', 74, boxY + 115)
       .font('Helvetica-Bold')
       .text('Mayo 2026', 170, boxY + 115);

    doc.font('Helvetica')
       .text('• Clasificación:', 74, boxY + 145)
       .font('Helvetica-Bold')
       .fillColor('#dc2626') // Rojo corporativo
       .text('Confidencial - Uso Interno', 170, boxY + 145);

    // --- LEER Y PARSEAR EL ARCHIVO DE TEXTO ---
    const textPath = path.join(__dirname, 'extracted_text.txt');
    if (!fs.existsSync(textPath)) {
        console.error(`Error: No se encuentra el archivo de texto en ${textPath}`);
        return;
    }
    const textContent = fs.readFileSync(textPath, 'utf8');
    const lines = textContent.split('\n');

    // Generación dinámica de páginas y contenido
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Omitir las líneas correspondientes a la portada
        if (i < 6) continue;

        if (line.startsWith('[Style: Heading1]')) {
            // Cada Heading 1 define el inicio exacto de una nueva sección en una nueva página
            doc.addPage();
            const title = line.replace('[Style: Heading1]', '').trim();
            doc.fillColor(colors.primary)
               .fontSize(14)
               .font('Helvetica-Bold')
               .text(title);
            doc.moveDown(0.8);

        } else if (line.startsWith('[Style: Heading2]')) {
            const subtitle = line.replace('[Style: Heading2]', '').trim();
            doc.moveDown(0.5);
            doc.fillColor(colors.secondary)
               .fontSize(11)
               .font('Helvetica-Bold')
               .text(subtitle);
            doc.moveDown(0.4);

        } else if (line.startsWith('[Style: Heading3]')) {
            const minititle = line.replace('[Style: Heading3]', '').trim();
            doc.moveDown(0.4);
            doc.fillColor(colors.accent)
               .fontSize(9.5)
               .font('Helvetica-Bold')
               .text(minititle);
            doc.moveDown(0.3);

        } else {
            // Párrafos de texto normal (Justificados con buen interlineado)
            doc.fillColor(colors.dark)
               .fontSize(9.5)
               .font('Helvetica')
               .text(line, { align: 'justify', lineGap: 3 });
            doc.moveDown(0.6);
        }
    }

    // --- ENCABEZADOS Y PIES DE PÁGINA PROFESIONALES ---
    const range = doc.bufferedPageRange();
    for (let i = 1; i < range.count; i++) {
        doc.switchToPage(i);

        // Guardar margen original para evitar desbordamiento y creación de páginas extra
        const oldBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        // Línea e información de encabezado
        doc.fillColor(colors.muted)
           .fontSize(8)
           .font('Helvetica')
           .text('🤖 SISTEMA DE COTIZACIONES Y BUSCADOR DE REFACCIONES', 54, 30, { align: 'right', width: 504 });
        
        doc.strokeColor(colors.border)
           .lineWidth(0.5)
           .moveTo(54, 42)
           .lineTo(558, 42)
           .stroke();

        // Línea e información de pie de página
        doc.strokeColor(colors.border)
           .lineWidth(0.5)
           .moveTo(54, 738)
           .lineTo(558, 738)
           .stroke();

        doc.fillColor(colors.muted)
           .fontSize(8)
           .font('Helvetica')
           .text('Confidencial - Uso Interno', 54, 746, { align: 'left', width: 250 });

        doc.text(`Página ${i + 1} de ${range.count}`, 308, 746, { align: 'right', width: 250 });

        // Restaurar margen original
        doc.page.margins.bottom = oldBottomMargin;
    }

    doc.end();
    console.log('✅ Documento PDF (.pdf) generado correctamente y libre de hojas en blanco.');
}

// =============================================================================
// PARTE 2: GENERACIÓN DEL DOCUMENTO WORD (.DOCX)
// =============================================================================

function generateWord() {
    const textPath = path.join(__dirname, 'extracted_text.txt');
    const textContent = fs.readFileSync(textPath, 'utf8');
    const lines = textContent.split('\n');

    const children = [];

    // --- PORTADA DE WORD ---
    children.push(
        new Paragraph({
            children: [
                new TextRun({
                    text: "🤖 SISTEMA DE COTIZACIONES Y BUSCADOR DE REFACCIONES",
                    color: "1E3A8A",
                    bold: true,
                    size: 36, // 18pt
                    font: "Arial"
                })
            ],
            alignment: AlignmentType.CENTER,
            spacing: { before: 1200, after: 180 },
        }),
        new Paragraph({
            children: [
                new TextRun({
                    text: "Manual de Usuario y Guía de Operación Completa",
                    color: "2563EB",
                    bold: true,
                    size: 24, // 12pt
                    font: "Arial"
                })
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 720 },
        }),
        new Paragraph({
            children: [
                new TextRun({
                    text: "Un sistema inteligente diseñado para simplificar la consulta de inventarios, automatizar ventas e interconectar a clientes con agentes comerciales en tiempo real mediante WhatsApp y la Web.",
                    color: "1E293B",
                    size: 20, // 10pt
                    font: "Arial"
                })
            ],
            alignment: AlignmentType.JUSTIFY,
            spacing: { after: 480 },
        }),
        new Paragraph({
            children: [
                new TextRun({ text: "• Dirigido a: ", color: "1E293B", bold: true, size: 19, font: "Arial" }),
                new TextRun({ text: "Usuarios finales, agentes de venta y personal operativo (No técnico).", color: "1E293B", size: 19, font: "Arial" })
            ],
            spacing: { after: 120 },
        }),
        new Paragraph({
            children: [
                new TextRun({ text: "• Tecnología principal: ", color: "1E293B", bold: true, size: 19, font: "Arial" }),
                new TextRun({ text: "WhatsApp Business API, Inteligencia Artificial Gemini y Panel Web.", color: "1E293B", size: 19, font: "Arial" })
            ],
            spacing: { after: 120 },
        }),
        new Paragraph({
            children: [
                new TextRun({ text: "• Última actualización: ", color: "1E293B", bold: true, size: 19, font: "Arial" }),
                new TextRun({ text: "Mayo 2026", color: "1E293B", size: 19, font: "Arial" })
            ],
            spacing: { after: 120 },
        }),
        new Paragraph({
            children: [
                new TextRun({ text: "• Clasificación: ", color: "1E293B", bold: true, size: 19, font: "Arial" }),
                new TextRun({ text: "Confidencial - Uso Interno", color: "DC2626", bold: true, size: 19, font: "Arial" })
            ],
            spacing: { after: 240 },
        })
    );

    // Procesar las líneas de contenido
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Omitir la sección de metadatos de la portada
        if (i < 6) continue;

        if (line.startsWith('[Style: Heading1]')) {
            const title = line.replace('[Style: Heading1]', '').trim();
            children.push(
                new Paragraph({
                    children: [
                        new TextRun({
                            text: title,
                            color: "1E3A8A",
                            bold: true,
                            size: 28, // 14pt
                            font: "Arial"
                        })
                    ],
                    pageBreakBefore: true, // Fuerza un salto de página limpio en Word para cada sección
                    spacing: { before: 240, after: 120 },
                })
            );
        } else if (line.startsWith('[Style: Heading2]')) {
            const subtitle = line.replace('[Style: Heading2]', '').trim();
            children.push(
                new Paragraph({
                    children: [
                        new TextRun({
                            text: subtitle,
                            color: "2563EB",
                            bold: true,
                            size: 22, // 11pt
                            font: "Arial"
                        })
                    ],
                    spacing: { before: 180, after: 80 },
                })
            );
        } else if (line.startsWith('[Style: Heading3]')) {
            const minititle = line.replace('[Style: Heading3]', '').trim();
            children.push(
                new Paragraph({
                    children: [
                        new TextRun({
                            text: minititle,
                            color: "0D9488",
                            bold: true,
                            size: 19, // 9.5pt
                            font: "Arial"
                        })
                    ],
                    spacing: { before: 120, after: 60 },
                })
            );
        } else {
            children.push(
                new Paragraph({
                    children: [
                        new TextRun({
                            text: line,
                            color: "1E293B",
                            size: 19, // 9.5pt
                            font: "Arial"
                        })
                    ],
                    spacing: { after: 120 },
                    alignment: AlignmentType.JUSTIFY,
                })
            );
        }
    }

    const docxObj = new Document({
        sections: [{
            properties: {},
            headers: {
                default: new Header({
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: "🤖 SISTEMA DE COTIZACIONES Y BUSCADOR DE REFACCIONES",
                                    color: "64748B",
                                    size: 16, // 8pt
                                    font: "Arial"
                                })
                            ],
                            alignment: AlignmentType.RIGHT,
                            spacing: { after: 120 }
                        })
                    ]
                })
            },
            footers: {
                default: new Footer({
                    children: [
                        new Paragraph({
                            children: [
                                new TextRun({
                                    text: "Confidencial - Uso Interno\t\tPágina ",
                                    color: "64748B",
                                    size: 16,
                                    font: "Arial"
                                }),
                                new SimpleField("PAGE"),
                                new TextRun({
                                    text: " de ",
                                    color: "64748B",
                                    size: 16,
                                    font: "Arial"
                                }),
                                new SimpleField("NUMPAGES")
                            ],
                            spacing: { before: 120 }
                        })
                    ]
                })
            },
            children: children,
        }],
    });

    const wordPath = path.join(__dirname, 'MANUAL_SISTEMA_REFACCIONES.docx');
    Packer.toBuffer(docxObj).then((buffer) => {
        fs.writeFileSync(wordPath, buffer);
        console.log('✅ Documento Word (.docx) generado correctamente.');
    }).catch(err => {
        console.error('Error al generar Word:', err);
    });
}

// Ejecutar ambas generaciones de forma secuencial
generatePDF();
generateWord();