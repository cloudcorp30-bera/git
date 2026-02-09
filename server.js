const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage for user sessions
const userSessions = new Map();

// BERA AI API Configuration
const API_CONFIG = {
    openai: {
        key: process.env.OPENAI_API_KEY || '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',
        endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    gemini: {
        key: process.env.GEMINI_API_KEY || 'AIzaSyDy_-cFa6R08UJRT4TcdVEhKUZqyNSljEQ',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    },
    grok: {
        key: process.env.GROK_API_KEY || 'xai-9lWoOejeRloEBKn6xDERoAodITl8NGbBlupxAzZl3ly8rT0oGrbk5D8DEqGoCImhZCDD535usWS8YwOp',
        chatEndpoint: 'https://api.x.ai/v1/chat/completions',
        imageEndpoint: 'https://api.x.ai/v1/images/generations'
    }
};

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

// User Session Management
function getUserSession(sessionId) {
    if (!userSessions.has(sessionId)) {
        userSessions.set(sessionId, {
            domainPattern: null,
            projectCounter: 1,
            deployedProjects: [],
            sessionId: sessionId,
            createdAt: new Date()
        });
    }
    return userSessions.get(sessionId);
}

// Domain Pattern Validation
function validateDomainPattern(pattern) {
    if (!pattern) return false;
    if (!pattern.includes('{ID}') && 
        !pattern.includes('{PROJECT_ID}') && 
        !pattern.includes('{NUMBER}')) {
        return false;
    }
    try {
        new URL(pattern.replace('{ID}', '001'));
        return true;
    } catch {
        return false;
    }
}

// Generate Next URL
function generateNextURL(session) {
    if (!session.domainPattern) return null;
    
    const id = session.projectCounter.toString().padStart(3, '0');
    return session.domainPattern.replace(/\{ID\}|\{PROJECT_ID\}|\{NUMBER\}/g, id);
}

// AI API Calls
async function callOpenAI(prompt, model = "gpt-4") {
    try {
        const response = await axios.post(API_CONFIG.openai.endpoint, {
            model: model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${API_CONFIG.openai.key}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI Error:', error.response?.data || error.message);
        return `Error: ${error.message}`;
    }
}

async function callGemini(prompt) {
    try {
        const response = await axios.post(
            `${API_CONFIG.gemini.endpoint}?key=${API_CONFIG.gemini.key}`,
            {
                contents: [{
                    parts: [{ text: prompt }]
                }]
            }
        );
        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Gemini Error:', error.response?.data || error.message);
        return `Error: ${error.message}`;
    }
}

async function callGrokChat(prompt) {
    try {
        const response = await axios.post(API_CONFIG.grok.chatEndpoint, {
            model: "grok-beta",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7
        }, {
            headers: {
                'Authorization': `Bearer ${API_CONFIG.grok.key}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Grok Error:', error.response?.data || error.message);
        return `Error: ${error.message}`;
    }
}

async function generateImageWithGrok(prompt) {
    try {
        const response = await axios.post(API_CONFIG.grok.imageEndpoint, {
            model: "grok-2-image",
            prompt: prompt,
            n: 1,
            response_format: "url"
        }, {
            headers: {
                'Authorization': `Bearer ${API_CONFIG.grok.key}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data.data[0].url;
    } catch (error) {
        console.error('Grok Image Error:', error.response?.data || error.message);
        return `Error: ${error.message}`;
    }
}

// BERA AI Multi-Agent Processing
async function processBERAProject(requirements, session) {
    const projectId = session.projectCounter.toString().padStart(3, '0');
    const deploymentURL = generateNextURL(session);
    
    console.log(`🚀 Starting Project ${projectId}: ${requirements}`);
    
    // 1. BERA ANALYZER
    const analysisPrompt = `Analyze these requirements and provide a project overview: "${requirements}"
    Format as JSON with: name, type, stack, complexity, features`;
    
    const analysis = await callOpenAI(analysisPrompt);
    
    // 2. BERA GENERATOR
    const generationPrompt = `Generate complete, runnable code for: ${requirements}
    Based on analysis: ${analysis}
    Include HTML, CSS, JavaScript for a web application.
    Make it production-ready and well-commented.`;
    
    const generatedCode = await callOpenAI(generationPrompt, "gpt-4-turbo");
    
    // 3. BERA DEBUGGER
    const debugPrompt = `Review and debug this code for any issues:\n${generatedCode}
    Provide specific fixes and improvements.`;
    
    const debugReport = await callGemini(debugPrompt);
    
    // 4. BERA TESTER
    const testPrompt = `Create test scenarios for this application: ${requirements}
    Based on code: ${generatedCode.substring(0, 500)}...
    Provide test cases and expected outcomes.`;
    
    const testResults = await callGrokChat(testPrompt);
    
    // 5. BERA IMAGE GENERATOR
    const imagePrompt = `Professional web application UI for: ${requirements}
    Modern design, clean interface, responsive layout`;
    
    let imageURL = null;
    if (requirements.toLowerCase().includes('ui') || 
        requirements.toLowerCase().includes('design') ||
        requirements.toLowerCase().includes('image')) {
        imageURL = await generateImageWithGrok(imagePrompt);
    }
    
    // Create project record
    const project = {
        id: projectId,
        name: requirements.substring(0, 50) + (requirements.length > 50 ? '...' : ''),
        requirements: requirements,
        deploymentURL: deploymentURL,
        createdAt: new Date(),
        analysis: analysis,
        code: generatedCode,
        debugReport: debugReport,
        testResults: testResults,
        imageURL: imageURL,
        status: 'completed'
    };
    
    session.deployedProjects.push(project);
    session.projectCounter++;
    
    return project;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/set-domain', (req, res) => {
    const { sessionId, domainPattern } = req.body;
    const session = getUserSession(sessionId);
    
    if (!validateDomainPattern(domainPattern)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid domain pattern. Must include {ID} placeholder and be a valid URL.'
        });
    }
    
    session.domainPattern = domainPattern;
    const nextURL = generateNextURL(session);
    
    res.json({
        success: true,
        message: '✅ Domain pattern saved',
        nextURL: nextURL,
        nextId: session.projectCounter.toString().padStart(3, '0'),
        sessionId: sessionId
    });
});

app.post('/api/create-project', async (req, res) => {
    const { sessionId, requirements } = req.body;
    const session = getUserSession(sessionId);
    
    if (!session.domainPattern) {
        return res.status(400).json({
            success: false,
            message: 'Please set a domain pattern first.'
        });
    }
    
    try {
        const project = await processBERAProject(requirements, session);
        
        res.json({
            success: true,
            message: '🚀 Project completed successfully!',
            project: project,
            nextId: session.projectCounter.toString().padStart(3, '0'),
            nextURL: generateNextURL(session)
        });
    } catch (error) {
        console.error('Project creation error:', error);
        res.status(500).json({
            success: false,
            message: 'Project creation failed: ' + error.message
        });
    }
});

app.get('/api/session-info/:sessionId', (req, res) => {
    const session = getUserSession(req.params.sessionId);
    
    res.json({
        domainPattern: session.domainPattern,
        projectCounter: session.projectCounter,
        nextId: session.projectCounter.toString().padStart(3, '0'),
        nextURL: generateNextURL(session),
        deployedCount: session.deployedProjects.length,
        deployedProjects: session.deployedProjects.map(p => ({
            id: p.id,
            name: p.name,
            url: p.deploymentURL,
            date: p.createdAt
        }))
    });
});

app.post('/api/reset-counter', (req, res) => {
    const { sessionId, newCounter } = req.body;
    const session = getUserSession(sessionId);
    
    const counter = parseInt(newCounter);
    if (isNaN(counter) || counter < 1) {
        return res.status(400).json({
            success: false,
            message: 'Invalid counter value'
        });
    }
    
    session.projectCounter = counter;
    
    res.json({
        success: true,
        message: `🔢 Counter reset to ${counter.toString().padStart(3, '0')}`,
        nextId: session.projectCounter.toString().padStart(3, '0'),
        nextURL: generateNextURL(session)
    });
});

app.post('/api/generate-image', async (req, res) => {
    const { prompt } = req.body;
    
    try {
        const imageURL = await generateImageWithGrok(prompt);
        
        res.json({
            success: true,
            imageURL: imageURL
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Image generation failed: ' + error.message
        });
    }
});

// Developer attribution endpoint
app.get('/api/developer', (req, res) => {
    res.json({
        developer: "Bruce Bera",
        system: "BERA AI (Build-Execute-Review-Automate Artificial Intelligence)",
        version: "4.0.0",
        mission: "Dynamic Domain AI Development System",
        contact: "bruce.bera@bera-ai.dev",
        organization: "Bera AI Development Labs",
        philosophy: "Flexible AI for flexible developers"
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
    ┌─────────────────────────────────────┐
    │                                     │
    │   🚀 BERA AI SYSTEM STARTED         │
    │                                     │
    │   🔗 http://localhost:${PORT}       │
    │   👨‍💻 Developer: Bruce Bera         │
    │   🎯 Version: 4.0.0                 │
    │                                     │
    └─────────────────────────────────────┘
    `);
});
