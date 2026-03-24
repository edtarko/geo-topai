import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function generateProjectData(count: number = 20) {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: `Generate structured data for the top ${count} open source AI projects. 
    Include projects like PyTorch, Transformers, LangChain, vLLM, llama.cpp, etc.
    Return a JSON object with:
    - companies: array of { id, name, website }
    - people: array of { id, name, github_handle, avatar_url }
    - projects: array of { id, name, github_url, stars, license, language, category, first_release, latest_version, latest_release_date, is_maintained, org_id, description }
    - dependencies: array of { from, to } (using IDs)
    - maintainers: array of { project_id, person_id }
    - topics: array of { project_id, topic }
    
    Ensure IDs are consistent. Category should be one of: framework, library, tool, model, dataset, application.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          companies: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                name: { type: Type.STRING },
                website: { type: Type.STRING },
              },
              required: ["id", "name"],
            },
          },
          people: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                name: { type: Type.STRING },
                github_handle: { type: Type.STRING },
                avatar_url: { type: Type.STRING },
              },
              required: ["id", "name"],
            },
          },
          projects: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                name: { type: Type.STRING },
                github_url: { type: Type.STRING },
                stars: { type: Type.NUMBER },
                license: { type: Type.STRING },
                language: { type: Type.STRING },
                category: { type: Type.STRING },
                first_release: { type: Type.STRING },
                latest_version: { type: Type.STRING },
                latest_release_date: { type: Type.STRING },
                is_maintained: { type: Type.BOOLEAN },
                org_id: { type: Type.STRING },
                description: { type: Type.STRING },
              },
              required: ["id", "name", "github_url", "stars", "license", "category"],
            },
          },
          dependencies: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                from: { type: Type.STRING },
                to: { type: Type.STRING },
              },
              required: ["from", "to"],
            },
          },
          maintainers: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                project_id: { type: Type.STRING },
                person_id: { type: Type.STRING },
              },
              required: ["project_id", "person_id"],
            },
          },
          topics: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                project_id: { type: Type.STRING },
                topic: { type: Type.STRING },
              },
              required: ["project_id", "topic"],
            },
          },
        },
      },
    },
  });

  return JSON.parse(response.text);
}
