import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { DEFAULT_TEMPLATE_CONFIG, type StandardTemplateConfig } from "./standard-template-config";

export { DEFAULT_TEMPLATE_CONFIG, type StandardTemplateConfig };

/**
 * Creates a clean, standard institutional blueprint PDF in-memory.
 * Can be fed directly into analyzeBlueprintBytes and fillBlueprintPdf.
 */
export async function createStandardBlueprintPdf(
  config: Partial<StandardTemplateConfig> = {},
): Promise<Uint8Array> {
  const merged: StandardTemplateConfig = {
    ...DEFAULT_TEMPLATE_CONFIG,
    ...config,
    generalInstructions:
      config.generalInstructions && config.generalInstructions.length > 0
        ? config.generalInstructions
        : DEFAULT_TEMPLATE_CONFIG.generalInstructions,
    sectionLabels:
      config.sectionLabels && config.sectionLabels.length > 0
        ? config.sectionLabels
        : DEFAULT_TEMPLATE_CONFIG.sectionLabels,
  };

  const document = await PDFDocument.create();
  const page = document.addPage([595.28, 841.89]); // A4
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const leftMargin = 48;
  const rightMargin = 48;
  const contentWidth = pageWidth - leftMargin - rightMargin;

  let y = pageHeight - 45;

  // 1. Institution Name (Centered)
  const schoolText = merged.schoolName.toUpperCase();
  const schoolSize = 15;
  const schoolWidth = bold.widthOfTextAtSize(schoolText, schoolSize);
  page.drawText(schoolText, {
    x: Math.max(leftMargin, (pageWidth - schoolWidth) / 2),
    y,
    font: bold,
    size: schoolSize,
    color: rgb(0.12, 0.16, 0.14),
  });
  y -= 20;

  // 2. Exam Title (Centered)
  const examText = merged.examTitle;
  const examSize = 12;
  const examWidth = bold.widthOfTextAtSize(examText, examSize);
  page.drawText(examText, {
    x: Math.max(leftMargin, (pageWidth - examWidth) / 2),
    y,
    font: bold,
    size: examSize,
    color: rgb(0.15, 0.2, 0.17),
  });
  y -= 22;

  // 3. Metadata row (Class & Subject on left, Time & Max Marks on right)
  const metaLeft = `Class: ${merged.className}   |   Subject: ${merged.subjectName}`;
  const metaRight = `Time: ${merged.durationMinutes} mins   |   Max. Marks: ${merged.maxMarks}`;
  const metaSize = 10;
  page.drawText(metaLeft, {
    x: leftMargin,
    y,
    font: regular,
    size: metaSize,
    color: rgb(0.2, 0.25, 0.22),
  });

  const metaRightWidth = regular.widthOfTextAtSize(metaRight, metaSize);
  page.drawText(metaRight, {
    x: pageWidth - rightMargin - metaRightWidth,
    y,
    font: regular,
    size: metaSize,
    color: rgb(0.2, 0.25, 0.22),
  });
  y -= 10;

  // Horizontal divider rule
  page.drawLine({
    start: { x: leftMargin, y },
    end: { x: pageWidth - rightMargin, y },
    thickness: 1,
    color: rgb(0.65, 0.72, 0.68),
  });
  y -= 18;

  // 4. General Instructions
  const giHeading = "General Instructions:";
  page.drawText(giHeading, {
    x: leftMargin,
    y,
    font: bold,
    size: 10,
    color: rgb(0.15, 0.2, 0.17),
  });
  y -= 14;

  for (let i = 0; i < merged.generalInstructions.length; i += 1) {
    const bullet = `${i + 1}. ${merged.generalInstructions[i]}`;
    // Wrap instruction text if needed
    const words = bullet.split(" ");
    let line = "";
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      if (regular.widthOfTextAtSize(testLine, 9) > contentWidth) {
        page.drawText(line, {
          x: leftMargin + 6,
          y,
          font: regular,
          size: 9,
          color: rgb(0.25, 0.3, 0.27),
        });
        y -= 12;
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) {
      page.drawText(line, {
        x: leftMargin + 6,
        y,
        font: regular,
        size: 9,
        color: rgb(0.25, 0.3, 0.27),
      });
      y -= 14;
    }
  }

  y -= 10;

  // 5. Placeholder Section Headings (will be detected as Tier 2 headings by blueprint analysis)
  for (const label of merged.sectionLabels) {
    page.drawText(label, {
      x: leftMargin,
      y,
      font: bold,
      size: 11,
      color: rgb(0.12, 0.16, 0.14),
    });
    y -= 14;
    page.drawText("Questions under this section", {
      x: leftMargin,
      y,
      font: regular,
      size: 9,
      color: rgb(0.5, 0.55, 0.52),
    });
    y -= 30;
  }

  // 6. Running Footer & Page Number
  const footerText = "Page 1 of 1";
  const footerSize = 9;
  const footerWidth = regular.widthOfTextAtSize(footerText, footerSize);
  page.drawText(footerText, {
    x: (pageWidth - footerWidth) / 2,
    y: 24,
    font: regular,
    size: footerSize,
    color: rgb(0.4, 0.45, 0.42),
  });

  return document.save();
}
